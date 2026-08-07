// Logique partagée entre la création de commande "staff" (routes/commandes.js)
// et la création de commande "client" (routes/commande-publique.js).

async function getNextNumero(db) {
  const snap = await db.collection('commandes').orderBy('createdAt', 'desc').limit(1).get();
  if (snap.empty) return 'CMD-0001';
  const last = snap.docs[0].data();
  const lastNum = parseInt((last.numero || 'CMD-0000').split('-')[1] || '0', 10);
  return `CMD-${String(lastNum + 1).padStart(4, '0')}`;
}

// Décrémente quantiteRestante dans stocks_plats pour chaque article commandé.
// Retourne la liste des noms d'articles désormais épuisés.
async function decrementStocksForItems(db, items, now) {
  const today = now.toISOString().split('T')[0];
  const epuises = [];
  for (const item of items) {
    if (!item.menuItemId) continue;
    const stockRef = db.collection('stocks_plats').doc(`${item.menuItemId}_${today}`);
    const stockDoc = await stockRef.get();
    if (stockDoc.exists) {
      const newRestante = Math.max(0, stockDoc.data().quantiteRestante - item.quantite);
      await stockRef.update({ quantiteRestante: newRestante, updatedAt: now.toISOString() });
      if (newRestante === 0) epuises.push(item.nom);
    }
  }
  return epuises;
}

module.exports = { getNextNumero, decrementStocksForItems };