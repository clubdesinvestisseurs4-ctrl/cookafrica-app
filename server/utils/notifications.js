const { db } = require('../firebase-admin');
const eventBus = require('./eventBus');

async function pushNotification({ type, icon, titre, message, createdBy }) {
  try {
    await db.collection('notifications').add({
      type: type || 'info',
      icon: icon || 'bell',
      titre,
      message,
      createdBy: createdBy || 'système',
      lu: false,
      createdAt: new Date().toISOString(),
    });
    eventBus.emit('notifications');
  } catch (_) {
    // Non bloquant
  }
}

module.exports = { pushNotification };
