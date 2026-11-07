const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateService } = require('../middleware/serviceAuth');
const { listeParPeriode } = require('../utils/listes');
const { periodeValide, chiffreAffaires, ventesParJour, depensesPourCompta } = require('../utils/integration');

const router = express.Router();

// Toutes les routes ici sont appelées par ERP-Compta (clé de service X-Service-Key,
// INTEGRATION_API_KEY), jamais par l'app elle-même.

// GET /api/integration/ca?debut=&fin= — "Audit Flash" : CA encaissé (factures payées,
// sans les bons CUI/BAR) comparé côté ERP au versement bancaire déclaré.
router.get('/ca', authenticateService, async (req, res) => {
  try {
    const { debut, fin } = req.query;
    if (!periodeValide(debut, fin)) return res.status(400).json({ error: 'debut et fin (AAAA-MM-JJ) sont requis' });
    const factures = await listeParPeriode('factures', debut, fin);
    res.json({ debut, fin, ...chiffreAffaires(factures) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

// GET /api/integration/journal?debut=&fin= — ce que l'ERP transforme en écritures :
// recettes encaissées par jour et par mode de paiement + dépenses saisies dans l'app.
// Limité à 92 jours (un trimestre) pour borner les lectures Firestore.
router.get('/journal', authenticateService, async (req, res) => {
  try {
    const { debut, fin } = req.query;
    if (!periodeValide(debut, fin)) return res.status(400).json({ error: 'debut et fin (AAAA-MM-JJ) sont requis' });
    if ((Date.parse(fin) - Date.parse(debut)) / 86_400_000 > 92) {
      return res.status(400).json({ error: 'Période limitée à 3 mois' });
    }
    const [factures, depSnap] = await Promise.all([
      listeParPeriode('factures', debut, fin),
      db.collection('depenses').where('date', '>=', debut).where('date', '<=', fin).get(),
    ]);
    res.json({
      debut, fin,
      ventes: ventesParJour(factures),
      depenses: depensesPourCompta(depSnap.docs.map(d => ({ id: d.id, ...d.data() }))),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = router;
