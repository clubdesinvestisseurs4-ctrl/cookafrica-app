// Endpoints publics — accessibles sans authentification depuis le lien de
// commande partagé au client (page client/commander.html). Le client ne
// touche jamais Firestore : tout passe par ici, comme le reste de l'API.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../firebase-admin');
const { pushNotification } = require('../utils/notifications');
const cache    = require('../utils/cache');
const eventBus = require('../utils/eventBus');
const { getNextNumero, decrementStocksForItems } = require('../utils/commandes');
const { resolvePublicItems, resolvePublicContact } = require('../utils/publicCommande');

const router = express.Router();

// Route non authentifiée exposée publiquement : limite dédiée, plus stricte
// que le quota global, pour empêcher le spam de commandes.
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de commandes envoyées depuis cet appareil, merci de patienter quelques minutes.' },
});

async function fetchMenuDisponible() {
  const snap = await db.collection('menu').where('disponible', '==', true).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// GET /api/public/menu — menu consultable sans authentification
router.get('/menu', async (req, res) => {
  try {
    let menu = cache.get('public:menu');
    if (!menu) {
      const docs = await fetchMenuDisponible();
      menu = docs
        .map(m => ({ id: m.id, nom: m.nom, categorie: m.categorie || '', prix: m.prix, description: m.description || '' }))
        .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
      cache.set('public:menu', menu, 30_000);
    }
    res.json(menu);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/public/commandes — le client passe sa propre commande depuis son téléphone.
// Elle part directement au statut 'en-preparation' : elle apparaît chez la caissière
// (onglet Commandes en Ligne) exactement comme une commande en ligne créée par le staff.
router.post('/commandes', orderLimiter, async (req, res) => {
  try {
    const { items, prenom, nom, telephone, localisation } = req.body;

    // Le menu est relu à chaque commande (jamais depuis le cache) pour garantir
    // que le prix facturé correspond toujours au prix réel au moment de l'achat.
    const menuDocs = await fetchMenuDisponible();
    const resolved = resolvePublicItems(items, menuDocs);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const resolvedContact = resolvePublicContact({ prenom, nom, telephone, localisation });
    if (resolvedContact.error) return res.status(400).json({ error: resolvedContact.error });
    const { contact } = resolvedContact;

    const numero = await getNextNumero(db);
    const now = new Date();

    const data = {
      numero,
      items: resolved.items,
      total: resolved.total,
      source: 'en-ligne',
      commandeClient: true,
      clientPrenom: contact.prenom,
      clientNom: contact.nom,
      clientTelephone: contact.telephone,
      clientLocalisation: contact.localisation,
      statut: 'en-preparation',
      date: now.toISOString().split('T')[0],
      createdBy: 'client-web',
      createdByNom: `${contact.prenom} ${contact.nom}`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const ref = await db.collection('commandes').add(data);
    cache.del('commandes:list', 'factures:list', 'stats:dashboard', 'stats:notifications');
    eventBus.emit('commandes');

    const epuises = await decrementStocksForItems(db, resolved.items, now);

    pushNotification({
      type: 'info', icon: 'user-clock',
      titre: `Nouvelle commande client ${numero}`,
      message: `${contact.prenom} ${contact.nom} – ${resolved.items.length} article(s) – Total : ${resolved.total.toLocaleString('fr-FR')} FCFA`,
      createdBy: 'client-web',
    });

    if (epuises.length > 0) {
      pushNotification({
        type: 'danger', icon: 'exclamation-circle',
        titre: '⚠️ Stock épuisé',
        message: `Plus de stock : ${epuises.join(', ')}`,
        createdBy: 'client-web',
      });
    }

    // Réponse volontairement limitée : pas de createdBy/source interne exposés au client.
    res.status(201).json({
      id: ref.id,
      numero,
      items: resolved.items,
      total: resolved.total,
      statut: data.statut,
      createdAt: data.createdAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/public/commandes/:id — suivi de statut pour le client, champs limités.
// L'ID Firestore (renvoyé une seule fois à la création) sert de jeton d'accès :
// aucune énumération possible, et seules les commandes marquées `commandeClient`
// sont exposées ici (une commande staff n'est jamais consultable par ce endpoint).
router.get('/commandes/:id', async (req, res) => {
  try {
    const doc = await db.collection('commandes').doc(req.params.id).get();
    if (!doc.exists || !doc.data().commandeClient) {
      return res.status(404).json({ error: 'Commande introuvable' });
    }
    const c = doc.data();
    res.json({ id: doc.id, numero: c.numero, statut: c.statut, items: c.items, total: c.total, createdAt: c.createdAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;