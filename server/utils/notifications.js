const { db } = require('../firebase-admin');
const eventBus = require('./eventBus');
const cache = require('./cache');

// Les 60 dernières notifications (badge et liste de l'admin), gardées en mémoire et
// complétées à chaque nouvelle notification au lieu d'être relues : chaque commande ou
// paiement en crée une, et le badge admin se rechargeait à chaque fois (jusqu'à 60
// lectures par minute pendant le service).
const NOTIF_KEY = 'notifications:list';
const NOTIF_MAX = 60;
// Filet de sécurité pour les notifications créées par un autre processus (AWS Lambda).
const NOTIF_TTL = 10 * 60_000;

function listeNotifications() {
  return cache.remember(NOTIF_KEY, NOTIF_TTL, async () => {
    const snap = await db.collection('notifications').orderBy('createdAt', 'desc').limit(NOTIF_MAX).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  });
}

function marquerToutesLuesEnCache() {
  (cache.get(NOTIF_KEY) || []).forEach(n => { n.lu = true; });
}

async function pushNotification({ type, icon, titre, message, createdBy }) {
  try {
    const data = {
      type: type || 'info',
      icon: icon || 'bell',
      titre,
      message,
      createdBy: createdBy || 'système',
      lu: false,
      createdAt: new Date().toISOString(),
    };
    const ref = await db.collection('notifications').add(data);
    const liste = cache.get(NOTIF_KEY);
    if (liste) {
      liste.unshift({ id: ref.id, ...data });
      if (liste.length > NOTIF_MAX) liste.length = NOTIF_MAX;
    }
    eventBus.emit('notifications');
  } catch (_) {
    // Non bloquant
  }
}

module.exports = { pushNotification, listeNotifications, marquerToutesLuesEnCache };
