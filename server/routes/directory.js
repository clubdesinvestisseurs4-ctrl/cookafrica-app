// Annuaire multi-site — monté uniquement sur le backend du site "maison" (voir
// DIRECTORY_ENABLED dans server.js). Ne contient aucune donnée de restaurant : juste
// la liste des admins ayant accès à plusieurs sites, et vers quel site les rediriger.
// Chaque site garde son propre système d'authentification (routes/auth.js) totalement
// inchangé — cet annuaire ne fait qu'émettre un jeton de bascule à échanger là-bas
// contre un vrai jeton de session (voir utils/directory.js).
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../firebase-admin');
const {
  signDirectorySession, verifyDirectorySession,
  signSwitchToken,
} = require('../utils/directory');

const router = express.Router();

// POST /api/directory/login — vérifie les identifiants (distincts du mot de passe
// de chaque site) et renvoie la liste des sites accessibles pour ce compte.
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiants requis' });
    }

    const snapshot = await db.collection('admin_directory')
      .where('username', '==', username.toLowerCase().trim())
      .limit(1).get();

    if (snapshot.empty) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const doc = snapshot.docs[0];
    const account = doc.data();

    const passwordMatch = await bcrypt.compare(password, account.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    res.json({
      directoryToken: signDirectorySession(doc.id),
      sites: (account.sites || []).map(s => ({ siteId: s.siteId, label: s.label })),
    });
  } catch (err) {
    console.error('Directory login error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/directory/switch — émet un jeton de bascule à usage unique pour le site
// choisi. Le client l'échange ensuite contre un vrai jeton via
// POST /api/auth/exchange-switch-token sur le backend de CE site (pas celui-ci).
router.post('/switch', async (req, res) => {
  try {
    const { directoryToken, siteId } = req.body;
    if (!directoryToken || !siteId) {
      return res.status(400).json({ error: 'directoryToken et siteId requis' });
    }

    let payload;
    try {
      payload = verifyDirectorySession(directoryToken);
    } catch {
      return res.status(401).json({ error: 'Session d\'annuaire invalide ou expirée' });
    }

    const doc = await db.collection('admin_directory').doc(payload.directoryId).get();
    if (!doc.exists) {
      return res.status(401).json({ error: 'Compte introuvable' });
    }

    const site = (doc.data().sites || []).find(s => s.siteId === siteId);
    if (!site) {
      return res.status(403).json({ error: 'Accès refusé à ce site' });
    }

    res.json({
      switchToken: signSwitchToken({ userId: site.userId, siteId: site.siteId }),
      apiUrl: site.apiUrl,
      appUrl: site.appUrl,
    });
  } catch (err) {
    console.error('Directory switch error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/directory/seed — crée ou met à jour un compte d'annuaire (admin multi-site).
// Protégé par le même jeton d'amorçage que POST /api/auth/seed (header X-Seed-Token).
// Contrairement à ce seed-là (comptes fixes, refuse si la base n'est pas vide), celui-ci
// est pensé pour être rejoué à chaque ajout/màj de compte multi-site — un admin doit déjà
// exister comme utilisateur normal (actif) sur chacun des sites listés dans `sites`.
router.post('/seed', async (req, res) => {
  try {
    const seedToken = process.env.SEED_TOKEN;
    if (!seedToken || req.headers['x-seed-token'] !== seedToken) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const { username, password, sites } = req.body;
    if (!username || !password || !Array.isArray(sites) || sites.length === 0) {
      return res.status(400).json({ error: 'username, password et sites (non vide) requis' });
    }
    for (const s of sites) {
      if (!s.siteId || !s.label || !s.apiUrl || !s.appUrl || !s.userId) {
        return res.status(400).json({ error: 'Chaque site nécessite siteId, label, apiUrl, appUrl, userId' });
      }
    }

    const normalizedUsername = username.toLowerCase().trim();
    const passwordHash = await bcrypt.hash(password, 10);
    const data = { username: normalizedUsername, passwordHash, sites, updatedAt: new Date().toISOString() };

    const existing = await db.collection('admin_directory')
      .where('username', '==', normalizedUsername).limit(1).get();

    if (!existing.empty) {
      await existing.docs[0].ref.update(data);
      return res.json({ message: 'Compte d\'annuaire mis à jour', id: existing.docs[0].id });
    }

    const ref = await db.collection('admin_directory').add({ ...data, createdAt: data.updatedAt });
    res.status(201).json({ message: 'Compte d\'annuaire créé', id: ref.id });
  } catch (err) {
    console.error('Directory seed error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
