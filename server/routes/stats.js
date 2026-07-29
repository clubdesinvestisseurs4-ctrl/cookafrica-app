const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken } = require('../middleware/auth');
const cache = require('../utils/cache');

const router = express.Router();

// GET /api/stats/dashboard
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    // Cache partagé avec commandes/factures : invalidé par leurs écritures,
    // donc jamais périmé plus de quelques secondes après un événement SSE.
    const cached = cache.get('stats:dashboard');
    if (cached) return res.json(cached);

    const today = new Date().toISOString().split('T')[0];

    const [todayCommandesSnap, activeCommandesSnap, facturesSnap, stocksSnap] = await Promise.all([
      db.collection('commandes').where('date', '==', today).get(),
      db.collection('commandes').where('statut', 'in', ['en-attente', 'en-preparation']).get(),
      db.collection('factures').where('date', '==', today).get(),
      db.collection('stocks').get(),
    ]);

    // Merge and deduplicate commandes (today's + active from any date)
    const commandesMap = new Map();
    todayCommandesSnap.docs.forEach(d => commandesMap.set(d.id, { id: d.id, ...d.data() }));
    activeCommandesSnap.docs.forEach(d => commandesMap.set(d.id, { id: d.id, ...d.data() }));
    const commandes = Array.from(commandesMap.values());

    const factures = facturesSnap.docs.map(d => d.data())
      .filter(f => !f.type || f.type === 'facture');
    const stocks   = stocksSnap.docs.map(d => d.data());

    const commandesJour    = commandes.filter(c => c.date === today);
    const commandesActives = commandes.filter(c => ['en-attente', 'en-preparation'].includes(c.statut));

    const facturesPayees = factures.filter(f => f.statut === 'payee');
    const revenusJour = facturesPayees.reduce((s, f) => s + (f.total || 0), 0);

    // Ventilation du chiffre d'affaires payé du jour entre plats et boissons
    let totalPlats = 0, totalBoissons = 0;
    facturesPayees.forEach(f => {
      (f.items || []).forEach(item => {
        if (item.categorie === 'Boissons') totalBoissons += item.sousTotal || 0;
        else totalPlats += item.sousTotal || 0;
      });
    });

    const commandesEnLigne = commandesJour.filter(c => c.source === 'en-ligne' && c.statut !== 'annulee').length;

    const alertesStock = stocks.filter(s => s.quantite < s.minimum).length;

    const commandesParStatut = {
      'en-attente':      commandes.filter(c => c.statut === 'en-attente').length,
      'en-preparation':  commandes.filter(c => c.statut === 'en-preparation').length,
      'servie':          commandesJour.filter(c => c.statut === 'servie').length,
    };

    const result = {
      commandesJour: commandesJour.length,
      commandesActives: commandesActives.length,
      revenusJour,
      totalPlats,
      totalBoissons,
      commandesEnLigne,
      alertesStock,
      commandesParStatut,
      commandesRecentes: commandesJour.slice(-5).reverse(),
    };

    cache.set('stats:dashboard', result, 60_000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/rapport?debut=YYYY-MM-DD&fin=YYYY-MM-DD
router.get('/rapport', authenticateToken, async (req, res) => {
  try {
    const { debut, fin } = req.query;

    let query = db.collection('factures');
    if (debut) query = query.where('date', '>=', debut);
    if (fin)   query = query.where('date', '<=', fin);
    const snap = await query.get();

    const factures = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const total = factures.reduce((s, f) => s + (f.total || 0), 0);
    const parMode = {};
    const parStatut = { payee: 0, partielle: 0 };

    factures.forEach(f => {
      parMode[f.modePaiement] = (parMode[f.modePaiement] || 0) + (f.total || 0);
      if (parStatut[f.statut] !== undefined) parStatut[f.statut]++;
    });

    const parCategorie = {};
    factures.forEach(f => {
      (f.items || []).forEach(item => {
        parCategorie[item.categorie || 'Autre'] = (parCategorie[item.categorie || 'Autre'] || 0) + (item.sousTotal || 0);
      });
    });

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
    const cached = cache.get('stats:notifications');
    if (cached) return res.json(cached);

    const [stocksSnap, activeCommandesSnap, partiellesSnap] = await Promise.all([
      db.collection('stocks').get(),
      db.collection('commandes').where('statut', 'in', ['en-attente', 'en-preparation']).get(),
      db.collection('factures').where('statut', '==', 'partielle').get(),
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

    const actives = activeCommandesSnap.size;
    if (actives > 0) {
      notifications.push({
        type: 'info', icon: 'fire',
        title: 'Commandes en cours',
        message: `${actives} commande(s) en attente / préparation`,
      });
    }

    if (partiellesSnap.size > 0) {
      notifications.push({
        type: 'danger', icon: 'receipt',
        title: `${partiellesSnap.size} facture(s) impayée(s)`,
        message: partiellesSnap.docs.slice(0, 3).map(d => {
          const f = d.data();
          return `${f.numero} – reste ${(f.reste || 0).toLocaleString('fr-FR')} FCFA`;
        }).join(' | '),
      });
    }

    cache.set('stats:notifications', notifications, 30_000);
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
