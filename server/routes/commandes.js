const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');
const cache    = require('../utils/cache');
const eventBus = require('../utils/eventBus');
const { buildCommandeUpdate } = require('../utils/commandeUpdate');
const {
  getNextNumero, decrementStocksForItems, resolveCommandeDate,
  MODES_CONSOMMATION, modeParDefaut, resolveModeConsommation,
  resolveSupplement, chargerCommandeParent, champsRattachement,
} = require('../utils/commandes');
const { ROLES_MODE } = require('../utils/commandeUpdate');
const { createFactureFromCommande } = require('../utils/factures');
const { listeParPeriode, LISTE_TTL } = require('../utils/listes');
const { formatMontant } = require('../utils/currency');

const router = express.Router();

// À appeler après chaque écriture. Les listes de commandes/factures (`*:list*`) ne sont
// plus vidées ici : chaque écriture les met à jour en mémoire (patchDoc, branché dans
// firebase-admin.js). Seules les vues calculées (dashboard, bilan) sont recalculées — à
// partir de ces listes, donc presque sans relecture.
function invalidate() {
  cache.del('stats:dashboard', 'stats:notifications', 'commandes:actives-anterieures');
  cache.delPrefix('stats:bilan:'); // le mode d'une commande ventile le bilan
}

// GET /api/commandes
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { statut, date, debut, fin, source } = req.query;

    // Un jour (vue par défaut, relue à chaque événement SSE pendant le service) ou une
    // période : filtre Firestore sur `date`, on ne lit que les commandes concernées. Les
    // listes restent en cache et sont tenues à jour à chaque écriture (patchDoc, voir
    // firebase-admin.js) : un événement SSE ne déclenche plus de relecture de la journée.
    // Avant le 2026-11-04, une période (onglet Commandes en ligne, même sur un seul jour)
    // relisait les 200 dernières commandes à chaque rafraîchissement.
    const d1 = date && !debut && !fin ? date : debut;
    const d2 = date && !debut && !fin ? date : fin;
    const all = d1 && d2
      ? await listeParPeriode('commandes', d1, d2)
      : await cache.remember('commandes:list', LISTE_TTL, async () => {
        // Vue sans filtre : les 200 plus récentes.
        const snap = await db.collection('commandes').orderBy('createdAt', 'desc').limit(200).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
      });

    let result = [...all];
    if (statut) result = result.filter(c => c.statut === statut);
    if (date)   result = result.filter(c => c.date === date);
    if (debut)  result = result.filter(c => c.date >= debut);
    if (fin)    result = result.filter(c => c.date <= fin);
    if (source) result = result.filter(c => c.source === source);

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
router.post('/', authenticateToken, requireRole('admin', 'serveur', 'caissiere', 'caissier-en-ligne'), async (req, res) => {
  try {
    const { items, note, tableNumero, source, date, modeConsommation, supplement, commandeParentId } = req.body;
    // Seuls admin/caissière/caissier en ligne peuvent marquer une commande "en ligne" (écran dédié)
    const isOnline = source === 'en-ligne' && ['admin', 'caissiere', 'caissier-en-ligne'].includes(req.user.role);

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'La commande doit contenir au moins un article' });
    }

    const total = items.reduce((sum, i) => sum + (Number(i.prix) * Number(i.quantite)), 0);
    const numero = await getNextNumero(db);
    const now = new Date();
    const resolvedDate = resolveCommandeDate(date, req.user.role, now);
    if (resolvedDate.error) return res.status(400).json({ error: resolvedDate.error });

    const mappedItems = items.map(i => ({
      menuItemId: i.menuItemId || '',
      nom: i.nom,
      prix: Number(i.prix),
      quantite: Number(i.quantite),
      sousTotal: Number(i.prix) * Number(i.quantite),
      categorie: i.categorie || '',
    }));

    let rattachement = {};
    if (commandeParentId) {
      const { parent, error } = await chargerCommandeParent(db, commandeParentId);
      if (error) return res.status(400).json({ error });
      rattachement = champsRattachement(parent);
    }

    const data = {
      numero,
      items: mappedItems,
      total,
      note: note || '',
      tableNumero: tableNumero || '',
      // `source` = canal (en ligne ou non) ; le mode sur place / à emporter est un champ
      // à part, renseigné sur TOUTES les commandes depuis le 2026-11-01.
      source: isOnline ? 'en-ligne' : 'sur-place',
      ...resolveModeConsommation(modeConsommation, req.user.role, mappedItems),
      modeEstime: false,
      ...resolveSupplement(supplement, mappedItems),
      ...rattachement, // supplément rattaché : prend le mode de sa commande d'origine
      statut: req.user.role === 'serveur' ? 'en-attente' : 'en-preparation',
      date: resolvedDate.date,
      createdBy: req.user.username,
      createdByNom: req.user.nom || req.user.username,
      // Rôle au moment de la création : sert à recalculer le mode automatique si les
      // articles changent, même si le compte change de rôle plus tard.
      createdByRole: req.user.role,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const ref = await db.collection('commandes').add(data);
    invalidate(resolvedDate.date);
    eventBus.emit('commandes');

    // Décrémenter quantiteRestante dans stocks_plats pour chaque article commandé
    const epuises = await decrementStocksForItems(db, mappedItems, now);

    pushNotification({
      type: 'info', icon: 'utensils',
      titre: `Nouvelle commande ${numero}`,
      message: `${items.length} article(s) – Total: ${formatMontant(total)}`,
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

    // Génère automatiquement la facture (statut 'partielle') : la caissière la
    // retrouve directement dans l'onglet Facturation, sans avoir à cliquer
    // "Nouvelle facture". Non bloquant : un souci ici ne doit pas empêcher
    // l'envoi de la commande — la caissière garde le bouton manuel en secours.
    try {
      const result = await createFactureFromCommande(db, commande, req.params.id, {
        createdBy: req.user.username,
      });
      if (result.facture) {
        invalidate();
        eventBus.emit('factures');
      }
    } catch (factureErr) {
      console.error('Auto-génération facture échouée pour', commande.numero, factureErr);
    }

    res.json({ id: req.params.id, ...commande, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/commandes/:id/items — modification libre des articles d'une commande, tant
// qu'aucune facture n'a encore été générée. Le serveur ne peut plus modifier une commande
// une fois envoyée à la facturation : elle appartient alors à la caissière.
// Pas de code admin requis pour baisser un prix ici (décision explicite du 2026-09-23 :
// tout rôle autorisé à modifier une commande peut le faire librement, sans code — contrairement
// à /api/factures/:id/pay et /edit-items, qui gardent le code admin pour une facture déjà émise).
router.put('/:id/items', authenticateToken, requireRole('admin', 'serveur', 'caissiere', 'caissier-en-ligne'), async (req, res) => {
  try {
    const { items, modeConsommation } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'La commande doit contenir au moins un article' });
    }
    if (modeConsommation !== undefined && !MODES_CONSOMMATION.includes(modeConsommation)) {
      return res.status(400).json({ error: 'Mode de consommation invalide' });
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

    // Le mode suit les articles tant que personne ne l'a choisi à la main (ex. une boisson
    // ajoutée fait passer une commande caisse en "sur place") ; un choix explicite envoyé
    // avec la modification l'emporte. Les commandes d'avant le 2026-11-01 n'ont pas de
    // createdByRole : leur mode n'est alors touché que sur choix explicite.
    const role = existing.createdByRole;
    if (modeConsommation !== undefined) {
      const auto = role ? modeParDefaut(role, mappedItems) : null;
      update.modeConsommation = modeConsommation;
      update.modeSource = modeConsommation === auto ? 'auto' : 'manuel';
      update.modeEstime = false;
    } else if (role && !['manuel', 'parent'].includes(existing.modeSource)) {
      update.modeConsommation = modeParDefaut(role, mappedItems);
      update.modeSource = 'auto';
    }
    // Même principe pour "supplément" : suit les articles tant qu'il vient de la règle.
    if (existing.supplementSource === 'auto' && !existing.commandeParentId) {
      Object.assign(update, resolveSupplement(undefined, mappedItems));
    }

    await docRef.update(update);
    invalidate();
    eventBus.emit('commandes');

    pushNotification({
      type: 'info', icon: 'edit',
      titre: 'Commande modifiée',
      message: `${existing.numero} – nouveau total : ${formatMontant(total)}`,
      createdBy: req.user.username,
    });

    res.json({ id: req.params.id, ...existing, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/commandes/:id/supplement — après coup (même facturée/servie) : marquer ou non
// comme supplément, et le rattacher à sa commande d'origine ou l'en détacher.
// Corps : { supplement: bool, commandeParentId?: string|null }. Change les statistiques,
// donc réservé aux mêmes rôles que la correction du mode (ROLES_MODE).
router.put('/:id/supplement', authenticateToken, requireRole(...ROLES_MODE), async (req, res) => {
  try {
    const { supplement, commandeParentId } = req.body;
    if (typeof supplement !== 'boolean') return res.status(400).json({ error: 'Champ "supplement" (vrai/faux) requis' });

    const docRef = db.collection('commandes').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Commande introuvable' });
    const existing = doc.data();
    if (existing.statut === 'annulee') return res.status(400).json({ error: 'Commande annulée' });

    const now = new Date();
    const update = { supplement, supplementSource: 'manuel', updatedAt: now.toISOString() };

    if (supplement && commandeParentId) {
      const { parent, error } = await chargerCommandeParent(db, commandeParentId, req.params.id);
      if (error) return res.status(400).json({ error });
      const aDesSupplements = await db.collection('commandes').where('commandeParentId', '==', req.params.id).limit(1).get();
      if (!aDesSupplements.empty) return res.status(400).json({ error: 'Cette commande a elle-même des suppléments rattachés' });
      Object.assign(update, champsRattachement(parent));
    } else if (existing.commandeParentId) {
      // Détachée : garde le mode qu'elle avait, désormais considéré comme un choix manuel.
      Object.assign(update, { commandeParentId: null, commandeParentNumero: null });
      if (existing.modeSource === 'parent') update.modeSource = 'manuel';
    }

    await docRef.update(update);
    invalidate();
    eventBus.emit('commandes');
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

    const { update, error, status } = buildCommandeUpdate(req.body, now, req.user.role);
    if (error) return res.status(status || 400).json({ error });

    await docRef.update(update);

    // Mode corrigé sur une commande d'origine : ses suppléments rattachés suivent.
    if (update.modeConsommation && update.modeConsommation !== existing.modeConsommation) {
      const enfants = await db.collection('commandes').where('commandeParentId', '==', req.params.id).get();
      await Promise.all(enfants.docs
        .filter(d => d.data().modeSource === 'parent')
        .map(d => d.ref.update({ modeConsommation: update.modeConsommation, updatedAt: now.toISOString() })));
    }

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
// Si la commande avait déjà été envoyée à la facturation et qu'une facture a
// été générée pour elle, cette facture n'a plus lieu d'être : on la supprime
// aussi pour éviter qu'elle reste visible en facturation pour une commande annulée.
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const docRef = db.collection('commandes').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Commande introuvable' });

    await docRef.update({
      statut: 'annulee',
      updatedAt: new Date().toISOString(),
    });

    const factSnap = await db.collection('factures').where('commandeId', '==', req.params.id).get();
    const factureSupprimee = !factSnap.empty;
    await Promise.all(factSnap.docs.map(d => d.ref.delete()));

    invalidate();
    eventBus.emit('commandes');
    if (factureSupprimee) eventBus.emit('factures');

    res.json({ message: 'Commande annulée', factureSupprimee });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
