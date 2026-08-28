const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');
const cache = require('../utils/cache');
const eventBus = require('../utils/eventBus');
const { getNextNumeroFacture } = require('../utils/factures');
const { formatMontant } = require('../utils/currency');

const router = express.Router();

function invalidate() {
  cache.del('reservations:list', 'factures:list', 'stats:dashboard', 'stats:notifications');
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Numérotation séquentielle des réservations (RESA-0001…), pour le reçu imprimé au moment
// de la réservation — indépendante de la numérotation des factures (FACT-xxxx), qui elle
// n'est attribuée que lors de la génération de la facture du jour J.
async function getNextNumeroReservation(db) {
  const snap = await db.collection('reservations').orderBy('createdAt', 'desc').limit(200).get();
  let maxNum = 0;
  snap.docs.forEach(doc => {
    const { numero } = doc.data();
    if (!numero || !numero.startsWith('RESA-')) return;
    const n = parseInt(numero.slice(5), 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  });
  return `RESA-${String(maxNum + 1).padStart(4, '0')}`;
}

// GET /api/reservations
router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    let all = cache.get('reservations:list');
    if (!all) {
      const snap = await db.collection('reservations').orderBy('dateEvenement', 'asc').get();
      all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      cache.set('reservations:list', all, 15_000);
    }
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reservations
router.post('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const {
      menu, salle, dateReservation, dateEvenement,
      nom, prenom, contact, email, nomEvenement,
      montantGlobal, avance,
    } = req.body;

    if (!dateEvenement) return res.status(400).json({ error: 'La date du jour J est requise' });
    if (!nom || !nomEvenement) return res.status(400).json({ error: "Le nom du client et de l'événement sont requis" });

    const montant = round2(montantGlobal);
    const acompte = round2(avance);
    if (montant <= 0) return res.status(400).json({ error: 'Le montant global doit être positif' });
    if (acompte < 0 || acompte > montant) return res.status(400).json({ error: "L'avance doit être comprise entre 0 et le montant global" });

    const numero = await getNextNumeroReservation(db);
    const now = new Date();
    const data = {
      numero,
      menu: menu || '',
      salle: salle || '',
      dateReservation: dateReservation || now.toISOString().split('T')[0],
      dateEvenement,
      nom: nom.trim(),
      prenom: (prenom || '').trim(),
      contact: contact || '',
      email: email || '',
      nomEvenement: nomEvenement.trim(),
      montantGlobal: montant,
      avance: acompte,
      reste: round2(montant - acompte),
      statut: 'en-attente',
      factureId: null,
      createdBy: req.user.username,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const ref = await db.collection('reservations').add(data);
    invalidate();
    eventBus.emit('reservations');

    pushNotification({
      type: 'info', icon: 'calendar-check',
      titre: 'Nouvelle réservation',
      message: `${data.nomEvenement} — ${data.nom} — ${data.dateEvenement}`,
      createdBy: req.user.username,
    });

    res.status(201).json({ id: ref.id, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/reservations/:id
router.put('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const docRef = db.collection('reservations').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Réservation introuvable' });

    const existing = doc.data();
    if (existing.statut === 'facturee') {
      return res.status(400).json({ error: 'Réservation déjà facturée, modification impossible' });
    }

    const {
      menu, salle, dateReservation, dateEvenement,
      nom, prenom, contact, email, nomEvenement,
      montantGlobal, avance,
    } = req.body;

    if (!dateEvenement) return res.status(400).json({ error: 'La date du jour J est requise' });
    if (!nom || !nomEvenement) return res.status(400).json({ error: "Le nom du client et de l'événement sont requis" });

    const montant = round2(montantGlobal);
    const acompte = round2(avance);
    if (montant <= 0) return res.status(400).json({ error: 'Le montant global doit être positif' });
    if (acompte < 0 || acompte > montant) return res.status(400).json({ error: "L'avance doit être comprise entre 0 et le montant global" });

    const update = {
      menu: menu || '',
      salle: salle || '',
      dateReservation: dateReservation || existing.dateReservation,
      dateEvenement,
      nom: nom.trim(),
      prenom: (prenom || '').trim(),
      contact: contact || '',
      email: email || '',
      nomEvenement: nomEvenement.trim(),
      montantGlobal: montant,
      avance: acompte,
      reste: round2(montant - acompte),
      updatedAt: new Date().toISOString(),
    };

    await docRef.update(update);
    invalidate();
    eventBus.emit('reservations');

    res.json({ id: req.params.id, ...existing, ...update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/reservations/:id
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const docRef = db.collection('reservations').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Réservation introuvable' });

    await docRef.delete();
    invalidate();
    eventBus.emit('reservations');

    res.json({ message: 'Réservation supprimée' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reservations/:id/facturer — génère la facture du jour J. Peut être appelé à
// n'importe quel moment (avant, pendant ou après l'événement) : la facture porte toujours
// la date du jour J, jamais la date du clic ni celle de la réservation.
router.post('/:id/facturer', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const docRef = db.collection('reservations').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Réservation introuvable' });

    const reservation = doc.data();
    if (reservation.statut === 'facturee') {
      return res.status(400).json({ error: 'Cette réservation a déjà été facturée' });
    }

    const numero = await getNextNumeroFacture(db);
    const now = new Date();
    const nomClient = `${reservation.prenom} ${reservation.nom}`.trim();

    const factureData = {
      numero,
      type: 'facture',
      commandeId: null,
      commandeNumero: null,
      reservationId: req.params.id,
      items: [{
        menuItemId: '',
        nom: reservation.menu || reservation.nomEvenement,
        prix: reservation.montantGlobal,
        quantite: 1,
        sousTotal: reservation.montantGlobal,
        categorie: 'Réservation',
      }],
      tableNumero: reservation.salle || '',
      note: `Réservation — ${reservation.nomEvenement} (${nomClient})`,
      total: reservation.montantGlobal,
      reste: reservation.reste,
      modePaiement: 'especes',
      statut: reservation.reste > 0 ? 'partielle' : 'payee',
      serveurNom: '',
      caissiereName: req.user.nom || req.user.username || '',
      date: reservation.dateEvenement,
      createdBy: req.user.username,
      createdAt: now.toISOString(),
    };

    const factureRef = await db.collection('factures').add(factureData);
    await docRef.update({
      statut: 'facturee',
      factureId: factureRef.id,
      updatedAt: now.toISOString(),
    });

    invalidate();
    eventBus.emit('reservations');
    eventBus.emit('factures');

    pushNotification({
      type: 'success', icon: 'receipt',
      titre: `Facture ${numero} générée`,
      message: `Réservation ${reservation.nomEvenement} — ${formatMontant(reservation.montantGlobal)}`,
      createdBy: req.user.username,
    });

    res.status(201).json({ facture: { id: factureRef.id, ...factureData } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;