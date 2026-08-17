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

    const [todayCommandesSnap, activeCommandesSnap, facturesSnap] = await Promise.all([
      db.collection('commandes').where('date', '==', today).get(),
      db.collection('commandes').where('statut', 'in', ['en-attente', 'en-preparation']).get(),
      db.collection('factures').where('date', '==', today).get(),
    ]);

    // Merge and deduplicate commandes (today's + active from any date)
    const commandesMap = new Map();
    todayCommandesSnap.docs.forEach(d => commandesMap.set(d.id, { id: d.id, ...d.data() }));
    activeCommandesSnap.docs.forEach(d => commandesMap.set(d.id, { id: d.id, ...d.data() }));
    const commandes = Array.from(commandesMap.values());

    const factures = facturesSnap.docs.map(d => d.data())
      .filter(f => !f.type || f.type === 'facture');

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

    // Commandes en ligne sur la période : un seul filtre Firestore sur 'date' (même champ
    // que ci-dessus, donc pas d'index composite requis), le tri par source/statut se fait
    // ensuite en mémoire — mêmes précautions que /api/commandes.
    let commandesQuery = db.collection('commandes');
    if (debut) commandesQuery = commandesQuery.where('date', '>=', debut);
    if (fin)   commandesQuery = commandesQuery.where('date', '<=', fin);

    const [snap, commandesSnap] = await Promise.all([query.get(), commandesQuery.get()]);

    const factures = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Commandes en ligne, badgées "Client" (commandeClient) ou "Caisse" (saisie par la
    // caissière) confondues — annulées exclues, ce compteur ne reflète que le volume traité.
    const commandesEnLigne = commandesSnap.docs
      .map(d => d.data())
      .filter(c => c.source === 'en-ligne' && c.statut !== 'annulee').length;

    const total = factures.reduce((s, f) => s + (f.total || 0), 0);
    const parMode = {};
    const parStatut = { payee: 0, partielle: 0 };

    factures.forEach(f => {
      parMode[f.modePaiement] = (parMode[f.modePaiement] || 0) + (f.total || 0);
      if (parStatut[f.statut] !== undefined) parStatut[f.statut]++;
    });

    // Ventilation par catégorie : chiffre d'affaires ET quantités vendues, pour TOUTES les
    // catégories du menu (pas seulement plats/boissons) — permet de filtrer le nombre
    // d'unités vendues d'une catégorie précise (Boissons, Accompagnement, Buffet…) sur la
    // période. Conserve aussi le classement plats/boissons existant pour compat.
    const parCategorie = {};
    const qteParCategorie = {};
    const platsVentes = {};
    const boissonsVentes = {};
    let totalPlatsQte = 0, totalBoissonsQte = 0;

    factures.forEach(f => {
      (f.items || []).forEach(item => {
        const cat = item.categorie || 'Autre';
        parCategorie[cat] = (parCategorie[cat] || 0) + (item.sousTotal || 0);
        qteParCategorie[cat] = (qteParCategorie[cat] || 0) + (item.quantite || 0);

        const isBoisson = cat === 'Boissons';
        const ventes = isBoisson ? boissonsVentes : platsVentes;
        if (!ventes[item.nom]) ventes[item.nom] = { quantite: 0, total: 0 };
        ventes[item.nom].quantite += item.quantite || 0;
        ventes[item.nom].total   += item.sousTotal || 0;

        if (isBoisson) totalBoissonsQte += item.quantite || 0;
        else            totalPlatsQte    += item.quantite || 0;
      });
    });

    const topVentes = (ventes) => Object.entries(ventes)
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
      qteParCategorie,
      commandesEnLigne,
      totalPlatsQte,
      totalBoissonsQte,
      topPlats: topVentes(platsVentes),
      topBoissons: topVentes(boissonsVentes),
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
