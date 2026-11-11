// Bons fidélité « loterie » — voir utils/fidelite.js pour les règles.
//   GET  /api/fidelite/bons/:code           → ce que la caisse voit au scan (lot + validité)
//   POST /api/fidelite/bons/:code/utiliser  → consomme le bon (une seule fois, transaction)
//   GET  /api/fidelite/stats?debut=&fin=    → bons distribués / utilisés par lot (admin)
const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const fid = require('../utils/fidelite');

const router = express.Router();
const BONS = 'bons_fidelite';
const CAISSE = ['admin', 'caissiere', 'caissier-en-ligne'];
const aujourdhui = () => new Date().toISOString().slice(0, 10); // Abidjan = UTC

// Appelé à l'encaissement (routes/factures.js). Retourne ce qui s'imprime sur le reçu
// ({ code, valableDes, expireLe } — jamais le lot), ou null si la facture n'y a pas droit.
async function creerBonSiEligible(dbx, { factureId, factureNumero, date, total, items, modeConsommation, createdBy }) {
  if (!fid.estEligible({ total, items, modeConsommation })) return null;
  const lot = fid.tirerLot(total);
  const { valableDes, expireLe } = fid.periodeValidite(date);
  for (let essai = 0; essai < 3; essai++) {
    const code = fid.genererCode();
    try {
      await dbx.collection(BONS).doc(code).create({
        code, factureId, factureNumero, montantFacture: total, date, lot, valableDes, expireLe,
        statut: 'actif', createdBy, createdAt: new Date().toISOString(),
      });
      const bon = { code, valableDes, expireLe };
      await dbx.collection('factures').doc(factureId).update({ bonFidelite: bon });
      return bon;
    } catch (err) {
      if (err.code !== 6) throw err; // 6 = ALREADY_EXISTS : collision de code, on retire
    }
  }
  return null;
}

router.get('/bons/:code', authenticateToken, requireRole(...CAISSE), async (req, res) => {
  try {
    const code = fid.normaliserCode(req.params.code);
    const doc = code ? await db.collection(BONS).doc(code).get() : null;
    const bon = doc && doc.exists ? doc.data() : null;
    res.json({ code, ...fid.etatBon(bon, aujourdhui()), bon });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bons/:code/utiliser', authenticateToken, requireRole(...CAISSE), async (req, res) => {
  try {
    const code = fid.normaliserCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Code requis' });
    const ref = db.collection(BONS).doc(code);
    const resultat = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const bon = doc.exists ? doc.data() : null;
      const etat = fid.etatBon(bon, aujourdhui());
      if (!etat.valide) return { ...etat, bon };
      const maj = { statut: 'utilise', utiliseLe: new Date().toISOString(), utilisePar: req.user.username };
      tx.update(ref, maj);
      return { valide: true, raison: 'utilise-maintenant', message: `Bon validé : ${bon.lot.libelle}. À offrir sur cette commande.`, bon: { ...bon, ...maj } };
    });
    res.json(resultat); // 200 même refusé : le client lit `valide` et affiche le message
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { debut, fin } = req.query;
    let q = db.collection(BONS);
    if (debut) q = q.where('date', '>=', debut);
    if (fin) q = q.where('date', '<=', fin);
    const snap = await q.get();
    const parLot = {};
    let utilises = 0;
    snap.docs.forEach((d) => {
      const b = d.data();
      const l = (parLot[b.lot.type] ||= { libelle: b.lot.libelle, distribues: 0, utilises: 0 });
      l.distribues += 1;
      if (b.statut === 'utilise') { l.utilises += 1; utilises += 1; }
    });
    res.json({ distribues: snap.size, utilises, tauxRetour: snap.size ? Math.round((utilises / snap.size) * 100) : 0, parLot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.creerBonSiEligible = creerBonSiEligible;
