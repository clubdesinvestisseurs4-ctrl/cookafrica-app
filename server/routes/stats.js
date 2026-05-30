const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// GET /api/stats/dashboard
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [commandesSnap, facturesSnap, stocksSnap] = await Promise.all([
      db.collection('commandes').get(),
      db.collection('factures').get(),
      db.collection('stocks').get(),
    ]);

    const commandes = commandesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const factures  = facturesSnap.docs.map(d => d.data());
    const stocks    = stocksSnap.docs.map(d => d.data());

    const commandesJour = commandes.filter(c => c.date === today);
    const commandesActives = commandes.filter(c => ['en-attente', 'en-preparation'].includes(c.statut));

    const revenusJour = factures
      .filter(f => f.date === today && f.statut === 'payee')
      .reduce((s, f) => s + (f.total || 0), 0);

    const alertesStock = stocks.filter(s => s.quantite < s.minimum).length;

    const commandesParStatut = {
      'en-attente':    commandes.filter(c => c.statut === 'en-attente').length,
      'en-preparation':commandes.filter(c => c.statut === 'en-preparation').length,
      'prete':         commandes.filter(c => c.statut === 'prete').length,
      'servie':        commandes.filter(c => c.date === today && c.statut === 'servie').length,
    };

    res.json({
      commandesJour: commandesJour.length,
      commandesActives: commandesActives.length,
      revenusJour,
      alertesStock,
      commandesParStatut,
      commandesRecentes: commandesJour.slice(-5).reverse(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/rapport?debut=YYYY-MM-DD&fin=YYYY-MM-DD
router.get('/rapport', authenticateToken, async (req, res) => {
  try {
    const { debut, fin } = req.query;
    const snap = await db.collection('factures').get();
    const factures = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(f => (!debut || f.date >= debut) && (!fin || f.date <= fin));

    const total = factures.reduce((s, f) => s + (f.total || 0), 0);
    const parMode = {};
    const parStatut = { payee: 0, partielle: 0 };

    factures.forEach(f => {
      parMode[f.modePaiement] = (parMode[f.modePaiement] || 0) + (f.total || 0);
      if (parStatut[f.statut] !== undefined) parStatut[f.statut]++;
    });

    // Ventes par catégorie
    const parCategorie = {};
    factures.forEach(f => {
      (f.items || []).forEach(item => {
        parCategorie[item.categorie || 'Autre'] = (parCategorie[item.categorie || 'Autre'] || 0) + (item.sousTotal || 0);
      });
    });

    // Top plats vendus
    const topPlats = {};
    factures.forEach(f => {
      (f.items || []).forEach(item => {
        if (!topPlats[item.nom]) topPlats[item.nom] = { quantite: 0, total: 0 };
        topPlats[item.nom].quantite += item.quantite || 0;
        topPlats[item.nom].total   += item.sousTotal || 0;
      });
    });
    const topPlatsArr = Object.entries(topPlats)
      .map(([nom, v]) => ({ nom, ...v }))
      .sort((a, b) => b.quantite - a.quantite)
      .slice(0, 5);

    res.json({
      total,
      nombre: factures.length,
      moyenne: Math.round(total / (factures.length || 1)),
      parMode,
      parStatut,
      parCategorie,
      topPlats: topPlatsArr,
      factures: factures.sort((a, b) => (b.date > a.date ? 1 : -1)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/notifications
router.get('/notifications', authenticateToken, async (req, res) => {
  try {
    const [stocksSnap, commandesSnap, facturesSnap] = await Promise.all([
      db.collection('stocks').get(),
      db.collection('commandes').get(),
      db.collection('factures').get(),
    ]);

    const notifications = [];

    stocksSnap.docs.forEach(d => {
      const s = d.data();
      if (s.quantite < s.minimum) {
        notifications.push({
          type: 'warning', icon: 'boxes',
          title: 'Stock bas',
          message: `${s.nom} : ${s.quantite} / ${s.minimum} ${s.unite || ''}`,
        });
      }
    });

    const actives = commandesSnap.docs
      .map(d => d.data())
      .filter(c => ['en-attente', 'en-preparation'].includes(c.statut));

    if (actives.length > 0) {
      notifications.push({
        type: 'info', icon: 'fire',
        title: 'Commandes en cours',
        message: `${actives.length} commande(s) en attente / préparation`,
      });
    }

    const partielles = facturesSnap.docs.filter(d => d.data().statut === 'partielle');
    if (partielles.length > 0) {
      notifications.push({
        type: 'danger', icon: 'receipt',
        title: `${partielles.length} facture(s) impayée(s)`,
        message: partielles.map(d => {
          const f = d.data();
          return `${f.numero} – reste ${(f.reste || 0).toLocaleString('fr-FR')} FCFA`;
        }).slice(0, 3).join(' | '),
      });
    }

    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
