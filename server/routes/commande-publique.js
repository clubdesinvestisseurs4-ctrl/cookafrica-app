// Endpoints publics — accessibles sans authentification depuis le lien de
// commande partagé au client (page client/commander.html). Le client ne
// touche jamais Firestore : tout passe par ici, comme le reste de l'API.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../firebase-admin');
const { pushNotification } = require('../utils/notifications');
const cache    = require('../utils/cache');
const eventBus = require('../utils/eventBus');
const { getNextNumero, decrementStocksForItems, determineModeConsommation } = require('../utils/commandes');
const { resolvePublicItems, resolvePublicContact } = require('../utils/publicCommande');
const { formatMontant } = require('../utils/currency');
const { menuEnCache } = require('../utils/listes');

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
    // Dérivé du menu en cache du personnel (vidé à chaque modification du menu) : avec un
    // TTL de 30 s propre à cette page publique, chaque visiteur — robots compris —
    // pouvait relancer une lecture de tout le menu. Le prix réellement facturé reste
    // vérifié à la commande (POST ci-dessous, relu dans Firestore).
    const menu = (await menuEnCache())
      .filter(m => m.disponible === true)
      .map(m => ({
        id: m.id, nom: m.nom, categorie: m.categorie || '', prix: m.prix, description: m.description || '',
        joursDisponibles: m.joursDisponibles || [],
      }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
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
      modeConsommation: determineModeConsommation(resolved.items),
      modeSource: 'auto',
      modeEstime: false,
      // Un client qui commande en ligne passe une vraie commande, même boisson seule :
      // la notion de supplément ne concerne que les ajouts saisis par le personnel.
      supplement: false,
      supplementSource: 'manuel',
      commandeClient: true,
      clientPrenom: contact.prenom,
      clientNom: contact.nom,
      clientTelephone: contact.telephone,
      clientLocalisation: contact.localisation,
      statut: 'en-preparation',
      date: now.toISOString().split('T')[0],
      createdBy: 'client-web',
      createdByNom: `${contact.prenom} ${contact.nom}`,
      createdByRole: 'client-web',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const ref = await db.collection('commandes').add(data);
    // Les listes de commandes en cache sont mises à jour par l'écriture elle-même (voir
    // firebase-admin.js) ; seules les vues calculées sont à refaire.
    cache.del('stats:dashboard', 'stats:notifications');
    cache.delPrefix('stats:bilan:');
    eventBus.emit('commandes');

    const epuises = await decrementStocksForItems(db, resolved.items, now);

    pushNotification({
      type: 'info', icon: 'user-clock',
      titre: `Nouvelle commande client ${numero}`,
      message: `${contact.prenom} ${contact.nom} – ${resolved.items.length} article(s) – Total : ${formatMontant(resolved.total)}`,
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
      modeConsommation: data.modeConsommation,
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
    res.json({ id: doc.id, numero: c.numero, statut: c.statut, items: c.items, total: c.total, modeConsommation: c.modeConsommation, createdAt: c.createdAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;