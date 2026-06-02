const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { pushNotification } = require('../utils/notifications');

const router = express.Router();

// Supprime le préfixe IPv6 ::ffff: pour normaliser les adresses IPv4
function normalizeIp(ip) {
  if (ip && ip.startsWith('::ffff:')) return ip.slice(7);
  return ip || '';
}

// Vérifie si une IP appartient à un bloc CIDR (ex: 192.168.1.0/24)
function ipInCidr(ip, cidr) {
  try {
    const [range, bits] = cidr.split('/');
    const mask = ~((1 << (32 - parseInt(bits, 10))) - 1) >>> 0;
    const toNum = s => s.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
    return (toNum(ip) & mask) === (toNum(range) & mask);
  } catch {
    return false;
  }
}

// Récupère la vraie IP du client en lisant X-Forwarded-For (première entrée = client original)
// req.ip seul ne suffit pas sur Render car plusieurs proxies internes (10.x.x.x) s'intercalent
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(req.ip);
}

// Retourne true si l'IP est autorisée selon ALLOWED_IPS
function isAllowedIp(req) {
  if (process.env.WIFI_RESTRICTION_ENABLED !== 'true') return true;
  const allowed = (process.env.ALLOWED_IPS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  const ip = getClientIp(req);
  return allowed.some(entry => entry.includes('/') ? ipInCidr(ip, entry) : ip === entry);
}

async function logSession(userId, username, nom, role, action, ip) {
  await db.collection('sessions').add({
    userId, username, nom, role, action,
    ip: ip || 'inconnue',
    timestamp: new Date().toISOString()
  });
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    if (!isAllowedIp(req)) {
      const clientIp = getClientIp(req);
      console.warn(`[WiFi] Tentative bloquée depuis ${clientIp} (X-Forwarded-For: ${req.headers['x-forwarded-for'] || 'absent'})`);
      return res.status(403).json({
        error: 'wifi_restricted',
        message: "Accès refusé : connectez-vous au réseau Wi-Fi de l'entreprise",
      });
    }

    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiants requis' });
    }

    const snapshot = await db.collection('utilisateurs')
      .where('username', '==', username.toLowerCase().trim())
      .where('actif', '==', true)
      .limit(1).get();

    if (snapshot.empty) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const userDoc = snapshot.docs[0];
    const user = userDoc.data();

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    await userDoc.ref.update({ lastLogin: new Date().toISOString() });
    await logSession(userDoc.id, user.username, user.nom, user.role, 'login', req.ip).catch(() => {});

    pushNotification({
      type: 'info', icon: 'sign-in-alt',
      titre: 'Connexion utilisateur',
      message: `${user.nom} (${user.role}) s'est connecté`,
      createdBy: user.username,
    });

    const nomComplet = user.prenom ? `${user.prenom} ${user.nom}`.trim() : user.nom;
    const token = jwt.sign(
      { id: userDoc.id, username: user.username, nom: nomComplet, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({ token, user: { id: userDoc.id, username: user.username, nom: nomComplet, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await logSession(req.user.id, req.user.username, req.user.nom, req.user.role, 'logout', req.ip);
    res.json({ message: 'Déconnexion enregistrée' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/sessions
router.get('/sessions', authenticateToken, requireRole('directeur'), async (req, res) => {
  try {
    const { debut, fin, username } = req.query;
    const snap = await db.collection('sessions').orderBy('timestamp', 'desc').limit(500).get();
    let sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (debut)    sessions = sessions.filter(s => s.timestamp >= debut);
    if (fin)      sessions = sessions.filter(s => s.timestamp <= fin + 'T23:59:59');
    if (username) sessions = sessions.filter(s => s.username === username);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/seed — initialisation des utilisateurs par défaut
router.post('/seed', async (req, res) => {
  try {
    const snapshot = await db.collection('utilisateurs').limit(1).get();
    if (!snapshot.empty) {
      return res.status(409).json({ error: 'Base déjà initialisée' });
    }

    const utilisateurs = [
      { username: 'admin',        nom: 'Admin Système',     role: 'directeur',      password: 'Admincookaf@2026!' },
      { username: 'receptio',     nom: 'Koné Aminata',      role: 'receptionniste', password: 'Receptcookaf@2026!' },
      { username: 'cuisinier',    nom: 'Diallo Moussa',     role: 'cuisinier',      password: 'Cuisincookaf@2026!' },
      { username: 'barman',       nom: 'Barman Service',    role: 'barman',         password: 'Barmancookaf@2026!' },
    ];

    const batch = db.batch();
    for (const u of utilisateurs) {
      const ref = db.collection('utilisateurs').doc();
      const passwordHash = await bcrypt.hash(u.password, 10);
      batch.set(ref, {
        username: u.username,
        nom: u.nom,
        role: u.role,
        passwordHash,
        actif: true,
        createdAt: new Date().toISOString(),
        lastLogin: null
      });
    }
    await batch.commit();

    res.json({ message: 'Utilisateurs créés', count: utilisateurs.length });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/auth/utilisateurs — liste des utilisateurs (directeur)
router.get('/utilisateurs', authenticateToken, requireRole('directeur'), async (req, res) => {
  try {
    const snap = await db.collection('utilisateurs').orderBy('createdAt', 'desc').get();
    const users = snap.docs.map(d => {
      const { passwordHash, ...rest } = d.data();
      return { id: d.id, ...rest };
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/utilisateurs — créer un utilisateur (directeur)
router.post('/utilisateurs', authenticateToken, requireRole('directeur'), async (req, res) => {
  try {
    const { prenom, nom, username, password, role } = req.body;
    const validRoles = ['directeur', 'receptionniste', 'cuisinier', 'barman'];
    if (!nom || !username || !password || !role) {
      return res.status(400).json({ error: 'Nom, identifiant, mot de passe et rôle requis' });
    }
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide' });
    }
    const existing = await db.collection('utilisateurs')
      .where('username', '==', username.toLowerCase().trim()).limit(1).get();
    if (!existing.empty) {
      return res.status(409).json({ error: 'Cet identifiant est déjà utilisé' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const data = {
      prenom: prenom?.trim() || '',
      nom: nom.trim(),
      username: username.toLowerCase().trim(),
      role,
      passwordHash,
      actif: true,
      createdAt: new Date().toISOString(),
      lastLogin: null,
    };
    const ref = await db.collection('utilisateurs').add(data);
    const { passwordHash: _, ...safe } = data;
    res.status(201).json({ id: ref.id, ...safe });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/utilisateurs/:id — modifier un utilisateur (directeur)
router.put('/utilisateurs/:id', authenticateToken, requireRole('directeur'), async (req, res) => {
  try {
    const { prenom, nom, role, password, actif } = req.body;
    const validRoles = ['directeur', 'receptionniste', 'cuisinier', 'barman'];
    const update = { updatedAt: new Date().toISOString() };
    if (nom !== undefined)   update.nom = nom.trim();
    if (prenom !== undefined) update.prenom = prenom.trim();
    if (role !== undefined) {
      if (!validRoles.includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
      update.role = role;
    }
    if (actif !== undefined) update.actif = actif;
    if (password) update.passwordHash = await bcrypt.hash(password, 10);
    await db.collection('utilisateurs').doc(req.params.id).update(update);
    res.json({ message: 'Utilisateur mis à jour' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/utilisateurs/:id — désactiver un utilisateur (directeur)
router.delete('/utilisateurs/:id', authenticateToken, requireRole('directeur'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre compte' });
    }
    await db.collection('utilisateurs').doc(req.params.id).update({
      actif: false,
      updatedAt: new Date().toISOString(),
    });
    res.json({ message: 'Utilisateur désactivé' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/seed-barman — ajouter le barman sur une installation existante
router.post('/seed-barman', async (req, res) => {
  try {
    const existing = await db.collection('utilisateurs')
      .where('username', '==', 'barman').limit(1).get();
    if (!existing.empty) {
      return res.status(409).json({ error: 'Barman déjà créé' });
    }
    const passwordHash = await bcrypt.hash('Barmancookaf@2026!', 10);
    await db.collection('utilisateurs').add({
      username: 'barman',
      nom: 'Barman Service',
      role: 'barman',
      passwordHash,
      actif: true,
      createdAt: new Date().toISOString(),
      lastLogin: null,
    });
    res.json({ message: 'Compte barman créé', username: 'barman', password: 'Barmancookaf@2026!' });
  } catch (err) {
    console.error('Seed barman error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
