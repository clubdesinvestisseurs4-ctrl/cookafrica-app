// Bons fidélité « loterie » — voir utils/fidelite.js pour les règles.
//   POST /api/fidelite/factures/:id/bon      → crée (une fois) le bon d'une facture à l'impression
//   GET  /api/fidelite/bons/:code            → ce que la caisse voit au scan (lot + validité)
//   POST /api/fidelite/bons/:code/utiliser   → { factureId } : consomme le bon ET applique le
//                                              cadeau sur cette facture (ligne négative)
//   GET  /api/fidelite/stats?debut=&fin=     → bons distribués / utilisés par lot (admin)
const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const cache = require('../utils/cache');
const eventBus = require('../utils/eventBus');
const fid = require('../utils/fidelite');

const router = express.Router();
const BONS = 'bons_fidelite';
const CAISSE = ['admin', 'caissiere', 'caissier-en-ligne'];
const aujourdhui = () => new Date().toISOString().slice(0, 10); // Abidjan = UTC

// À l'impression du reçu, payé ou non (décision du 2026-11-11) : il suffit que la commande
// soit sur place, avec un buffet, pour au moins 10 000. Idempotent : réimprimer redonne le même bon.
router.post('/factures/:id/bon', authenticateToken, requireRole(...CAISSE), async (req, res) => {
  try {
    const factureRef = db.collection('factures').doc(req.params.id);
    const bon = await db.runTransaction(async (tx) => {
      const fDoc = await tx.get(factureRef);
      if (!fDoc.exists) return null;
      const f = fDoc.data();
      if (f.bonFidelite) return f.bonFidelite;
      let modeConsommation;
      if (f.commandeId) {
        const cDoc = await tx.get(db.collection('commandes').doc(f.commandeId));
        if (cDoc.exists) modeConsommation = cDoc.data().modeConsommation;
      }
      if (!fid.estEligible({ total: f.total, items: f.items, modeConsommation })) return null;
      const code = fid.genererCode(); // ~50 bits d'aléa : collision négligeable
      const { valableDes, expireLe } = fid.periodeValidite(f.date || aujourdhui());
      tx.create(db.collection(BONS).doc(code), {
        code, factureId: req.params.id, factureNumero: f.numero, montantFacture: f.total, date: f.date || aujourdhui(),
        lot: fid.tirerLot(f.total), valableDes, expireLe, statut: 'actif',
        createdBy: req.user.username, createdAt: new Date().toISOString(),
      });
      const b = { code, valableDes, expireLe };
      tx.update(factureRef, { bonFidelite: b });
      return b;
    });
    if (bon) cache.delPrefix('factures:list'); // écriture en transaction : non suivie par le cache
    res.json({ bonFidelite: bon });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// Réponse toujours 200 avec `valide` : le client affiche `message` (api() masque les 4xx).
router.post('/bons/:code/utiliser', authenticateToken, requireRole(...CAISSE), async (req, res) => {
  try {
    const code = fid.normaliserCode(req.params.code);
    const { factureId } = req.body || {};
    if (!code || !factureId) return res.json({ valide: false, message: 'Choisissez la facture du client.' });
    const bonRef = db.collection(BONS).doc(code);
    const factureRef = db.collection('factures').doc(String(factureId));
    const r = await db.runTransaction(async (tx) => {
      const [bDoc, fDoc] = await Promise.all([tx.get(bonRef), tx.get(factureRef)]);
      const bon = bDoc.exists ? bDoc.data() : null;
      const etat = fid.etatBon(bon, aujourdhui());
      if (!etat.valide) return { ...etat, bon };
      if (!fDoc.exists) return { valide: false, message: 'Facture introuvable.' };
      const f = fDoc.data();
      if (f.statut === 'payee') return { valide: false, message: 'Cette facture est déjà payée : choisissez une facture en cours.' };
      if (fDoc.id === bon.factureId) return { valide: false, message: 'Le bon ne peut pas servir sur la facture qui l\'a fait gagner.' };
      const { ligne, error } = fid.ligneCadeau(bon, f.items);
      if (error) return { valide: false, message: error };
      const items = [...(f.items || []), ligne];
      const total = items.reduce((s, i) => s + (Number(i.sousTotal) || 0), 0);
      const now = new Date().toISOString();
      const majFacture = { items, total, reste: total, updatedAt: now, lastEditedBy: req.user.username, lastEditedAt: now };
      tx.update(factureRef, majFacture);
      tx.update(bonRef, { statut: 'utilise', utiliseLe: now, utilisePar: req.user.username, factureUtilisation: fDoc.id, factureUtilisationNumero: f.numero || '', montantOffert: -ligne.prix });
      return { valide: true, message: `Cadeau appliqué sur ${f.numero} : ${bon.lot.libelle} (−${-ligne.prix} FCFA).`, facture: { id: fDoc.id, ...f, ...majFacture } };
    });
    if (r.facture) {
      cache.delPrefix('factures:list');
      cache.del('stats:dashboard');
      cache.delPrefix('stats:bilan:');
      eventBus.emit('factures');
    }
    res.json(r);
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
    const parPalier = {};
    let utilises = 0;
    let offert = 0;
    let caOrigine = 0;
    snap.docs.forEach((d) => {
      const b = d.data();
      const l = (parLot[b.lot.type] ||= { libelle: b.lot.libelle, distribues: 0, utilises: 0, offert: 0 });
      const p = (parPalier[b.lot.palier] ||= { distribues: 0, utilises: 0 });
      l.distribues += 1; p.distribues += 1;
      caOrigine += Number(b.montantFacture) || 0;
      if (b.statut === 'utilise') {
        l.utilises += 1; p.utilises += 1; utilises += 1;
        l.offert += Number(b.montantOffert) || 0; offert += Number(b.montantOffert) || 0;
      }
    });
    res.json({ distribues: snap.size, utilises, tauxRetour: snap.size ? Math.round((utilises / snap.size) * 100) : 0, offert, caOrigine, parLot, parPalier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
