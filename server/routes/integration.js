const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateService } = require('../middleware/serviceAuth');

const router = express.Router();

// GET /api/integration/ca?debut=YYYY-MM-DD&fin=YYYY-MM-DD — utilisé par ERP-Compta ("Audit Flash")
// pour comparer le chiffre d'affaires réel au versement bancaire déclaré. Seules les factures
// payées comptent (base encaissement, cohérente avec un rapprochement de trésorerie) — une
// facture "partielle" ne représente pas encore de l'argent effectivement reçu.
router.get('/ca', authenticateService, async (req, res) => {
  try {
    const { debut, fin } = req.query;
    if (!debut || !fin) {
      return res.status(400).json({ error: 'debut et fin sont requis' });
    }

    const snap = await db.collection('factures')
      .where('date', '>=', debut)
      .where('date', '<=', fin)
      .get();

    const factures = snap.docs.map(d => d.data()).filter(f => f.statut === 'payee');

    const parMode = {};
    factures.forEach(f => {
      parMode[f.modePaiement] = (parMode[f.modePaiement] || 0) + (f.total || 0);
    });
    const total = factures.reduce((s, f) => s + (f.total || 0), 0);

    res.json({ debut, fin, total, nombre: factures.length, parMode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = router;