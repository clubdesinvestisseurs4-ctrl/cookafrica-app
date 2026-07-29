const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');
const cache    = require('../utils/cache');
const eventBus = require('../utils/eventBus');
const { buildCommandeUpdate } = require('../utils/commandeUpdate');

const router = express.Router();

// Invalide tous les caches commandes + factures (à appeler après chaque écriture)
function invalidate() {
  cache.del('commandes:list', 'factures:list', 'stats:dashboard', 'stats:notifications');
}

async function getNextNumero() {
  const snap = await db.collection('commandes').orderBy('createdAt', 'desc').limit(1).get();
  if (snap.empty) return 'CMD-0001';
  const last = snap.docs[0].data();
  const lastNum = parseInt((last.numero || 'CMD-0000').split('-')[1] || '0', 10);
  return `CMD-${String(lastNum + 1).padStart(4, '0')}`;
}

// GET /api/commandes
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { statut, date } = req.query;

    let all = cache.get('commandes:list');
    if (!all) {
      const snap = await db.collection('commandes').orderBy('createdAt', 'desc').limit(200).get();
      all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      cache.set('commandes:list', all, 15_000);
    }

    let result = all;
    if (statut) result = result.filter(c => c.statut === statut);
    if (date)   result = result.filter(c => c.date === date);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/commandes
// Le serveur crée une commande qui reste sous son contrôle (statut 'en-attente') tant
// qu'il ne l'a pas explicitement envoyée à la facturation (PUT /:id/envoyer).
// Une commande créée directement par l'admin/la caissière (dont les commandes en ligne)
// part immédiatement au statut 'en-preparation' : elle reste au niveau de la caissière,
// pas besoin d'un envoi depuis un serveur.
router.post('/', authenticateToken, requireRole('admin', 'serveur', 'caissiere'), async (req, res) => {
  try {
    const { items, note, tableNumero, source } = req.body;
    // Seuls admin/caissière peuvent marquer une commande "en ligne" (écran dédié)
    const isOnline = source === 'en-ligne' && ['admin', 'caissiere'].includes(req.user.role);

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'La commande doit contenir au moins un article' });
    }

    const total = items.reduce((sum, i) => sum + (Number(i.prix) * Number(i.quantite)), 0);
    const numero = await getNextNumero();
    const now = new Date();

    const mappedItems = items.map(i => ({
      menuItemId: i.menuItemId || '',
      nom: i.nom,
      prix: Number(i.prix),
      quantite: Number(i.quantite),
      sousTotal: Number(i.prix) * Number(i.quantite),
      categorie: i.categorie || '',
    }));

    const data = {
      numero,
      items: mappedItems,
      total,
      note: note || '',
      tableNumero: tableNumero || '',
      source: isOnline ? 'en-ligne' : 'sur-place',
      statut: req.user.role === 'serveur' ? 'en-attente' : 'en-preparation',
      date: now.toISOString().split('T')[0],
      createdBy: req.user.username,
      createdByNom: req.user.nom || req.user.username,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const ref = await db.collection('commandes').add(data);
    invalidate();
    eventBus.emit('commandes');

    // Décrémenter quantiteRestante dans stocks_plats pour chaque article commandé
    const today = now.toISOString().split('T')[0];
    const epuises = [];
    for (const item of mappedItems) {
      if (!item.menuItemId) continue;
      const stockRef = db.collection('stocks_plats').doc(`${item.menuItemId}_${today}`);
      const stockDoc = await stockRef.get();
      if (stockDoc.exists) {
        const newRestante = Math.max(0, stockDoc.data().quantiteRestante - item.quantite);
        await stockRef.update({ quantiteRestante: newRestante, updatedAt: now.toISOString() });
        if (newRestante === 0) epuises.push(item.nom);
      }
    }

    pushNotification({
      type: 'info', icon: 'utensils',
      titre: `Nouvelle commande ${numero}`,
      message: `${items.length} article(s) – Total: ${total.toLocaleString('fr-FR')} FCFA`,
      createdBy: req.user.username,
    });

    if (epuises.length > 0) {
      pushNotification({
        type: 'danger', icon: 'exclamation-circle',
        titre: '⚠️ Stock épuisé',
        message: `Plus de stock : ${epuises.join(', ')}`,
        createdBy: req.user.username,
      });
    }

    res.status(201).json({ id: ref.id, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/commandes/:id/envoyer — le serveur envoie sa commande à la facturation.
// Elle passe alors sous le contrôle de la caissière (elle peut la modifier et la facturer).
router.put('/:id/envoyer', authenticateToken, requireRole('admin', 'serveur'), async (req, res) => {
  try {
    const docRef = db.collection('commandes').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const commande = doc.data();
    if (commande.statut !== 'en-attente') {
      return res.status(400).json({ error: 'Cette commande a déjà été envoyée à la facturation' });
    }

    const now = new Date();
    const update = {
      statut: 'en-preparation',
      envoyeeAt: now.toISOString(),
      envoyeeBy: req.user.username,
      envoyeeByNom: req.user.nom || req.user.username,
      updatedAt: now.toISOString(),
    };
    await docRef.update(update);
    invalidate();
    eventBus.emit('commandes');

    pushNotification({
      type: 'info', icon: 'paper-plane',
      titre: 'Commande envoyée à la facturation',
      message: `${commande.numero} – prête à être facturée`,
      createdBy: req.user.username,
    });

    res.json({ id: req.params.id, ...commande, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/commandes/:id/items — modification libre des articles d'une commande, tant
// qu'aucune facture n'a encore été générée. Le serveur ne peut plus modifier une commande
// une fois envoyée à la facturation : elle appartient alors à la caissière.
router.put('/:id/items', authenticateToken, requireRole('admin', 'serveur', 'caissiere'), async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'La commande doit contenir au moins un article' });
    }

    const docRef = db.collection('commandes').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const existing = doc.data();
    if (['annulee', 'servie'].includes(existing.statut)) {
      return res.status(400).json({ error: 'Commande déjà terminée, modification impossible' });
    }
    if (existing.statut === 'en-preparation' && req.user.role === 'serveur') {
      return res.status(400).json({ error: 'Commande déjà envoyée à la facturation — seule la caissière peut la modifier' });
    }

    const existingFactSnap = await db.collection('factures').where('commandeId', '==', req.params.id).get();
    const hasPaymentFact = existingFactSnap.docs.some(d => { const t = d.data().type; return !t || t === 'facture'; });
    if (hasPaymentFact) {
      return res.status(400).json({ error: 'Une facture existe déjà — seul un admin peut modifier via un code de modification' });
    }

    const mappedItems = items.map(i => ({
      menuItemId: i.menuItemId || '',
      nom: i.nom,
      prix: Number(i.prix),
      quantite: Number(i.quantite),
      sousTotal: Number(i.prix) * Number(i.quantite),
      categorie: i.categorie || '',
    }));
    const total = mappedItems.reduce((s, i) => s + i.sousTotal, 0);
    const now = new Date();

    const update = {
      items: mappedItems,
      total,
      updatedAt: now.toISOString(),
      lastEditedBy: req.user.username,
      lastEditedByNom: req.user.nom || req.user.username,
      lastEditedAt: now.toISOString(),
    };

    await docRef.update(update);
    invalidate();
    eventBus.emit('commandes');

    pushNotification({
      type: 'info', icon: 'edit',
      titre: 'Commande modifiée',
      message: `${existing.numero} – nouveau total : ${total.toLocaleString('fr-FR')} FCFA`,
      createdBy: req.user.username,
    });

    res.json({ id: req.params.id, ...existing, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/commandes/:id — mise à jour statut ou infos (note, table)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const docRef = db.collection('commandes').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const existing = doc.data();
    const now = new Date();

    const { update, error } = buildCommandeUpdate(req.body, now);
    if (error) return res.status(400).json({ error });

    await docRef.update(update);
    invalidate();
    eventBus.emit('commandes');

    if (update.statut && update.statut !== existing.statut) {
      const messages = {
        'servie':  { type: 'success', icon: 'concierge-bell', titre: 'Commande servie', msg: `${existing.numero} – servie au client` },
        'annulee': { type: 'danger',  icon: 'times-circle',   titre: 'Commande annulée', msg: `${existing.numero} – annulée` },
      };
      const notif = messages[update.statut];
      if (notif) pushNotification({ type: notif.type, icon: notif.icon, titre: notif.titre, message: notif.msg, createdBy: req.user.username });
    }

    res.json({ id: req.params.id, ...existing, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/commandes/:id — annulation (admin uniquement)
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    await db.collection('commandes').doc(req.params.id).update({
      statut: 'annulee',
      updatedAt: new Date().toISOString(),
    });
    invalidate();
    eventBus.emit('commandes');
    res.json({ message: 'Commande annulée' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
