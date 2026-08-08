// Logique partagée entre la génération manuelle de facture (routes/factures.js)
// et la génération automatique dès qu'une commande arrive en caisse
// (routes/commandes.js PUT /:id/envoyer).

async function getNextNumeroFacture(db) {
  // Scan les 200 derniers documents et trouve le numéro FACT le plus élevé.
  // Évite le bug où un bon cuisine/bar (CUI-CMD-0001, BAR-CMD-0001) est le
  // document le plus récent, ce qui faisait parseInt("CMD", 10) → NaN → "FACT-0NaN".
  const snap = await db.collection('factures').orderBy('createdAt', 'desc').limit(200).get();
  let maxNum = 0;
  snap.docs.forEach(doc => {
    const { numero } = doc.data();
    if (!numero || !numero.startsWith('FACT-')) return;
    const n = parseInt(numero.slice(5), 10); // slice(5) = après "FACT-"
    if (!isNaN(n) && n > maxNum) maxNum = n;
  });
  return `FACT-${String(maxNum + 1).padStart(4, '0')}`;
}

// Crée la facture (statut 'partielle', reste = total) associée à une commande
// déjà en 'en-preparation'. Retourne { error } si la commande est vide ou si
// une facture existe déjà pour elle, sinon { facture }.
async function createFactureFromCommande(db, commande, commandeId, { modePaiement, createdBy, caissiereName } = {}) {
  const allItems = commande.items || [];
  if (allItems.length === 0) return { error: 'La commande est vide' };

  const existing = await db.collection('factures').where('commandeId', '==', commandeId).limit(1).get();
  if (!existing.empty) return { error: 'Une facture existe déjà pour cette commande' };

  const total = allItems.reduce((sum, i) => sum + i.sousTotal, 0);
  const numero = await getNextNumeroFacture(db);
  const now = new Date();

  const data = {
    numero,
    type: 'facture',
    commandeId,
    commandeNumero: commande.numero,
    items: allItems,
    tableNumero: commande.tableNumero || '',
    note: commande.note || '',
    total,
    reste: total,
    modePaiement: modePaiement || 'especes',
    statut: 'partielle',
    serveurNom: commande.createdByNom || commande.createdBy || '',
    caissiereName: caissiereName || '',
    date: now.toISOString().split('T')[0],
    createdBy: createdBy || 'system',
    createdAt: now.toISOString(),
  };

  const ref = await db.collection('factures').add(data);
  return { facture: { id: ref.id, ...data } };
}

module.exports = { getNextNumeroFacture, createFactureFromCommande };