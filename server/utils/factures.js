// Logique partagée entre la génération manuelle de facture (routes/factures.js)
// et la génération automatique dès qu'une commande arrive en caisse
// (routes/commandes.js PUT /:id/envoyer).

// Compteur dédié (collection counters, doc "factures") au lieu de rescanner les
// factures à chaque appel : avant, CHAQUE facture créée (auto à l'envoi d'une
// commande, ou manuelle) relisait jusqu'à 200 documents pour retrouver le numéro
// FACT le plus élevé — coût énorme et qui grossit avec l'historique. Désormais 1
// lecture + 1 écriture par facture, quel que soit le nombre de factures déjà créées.
async function getNextNumeroFacture(db) {
  const counterRef = db.collection('counters').doc('factures');
  const counterSnap = await counterRef.get();

  if (!counterSnap.exists) {
    // Tout premier appel depuis l'ajout de ce compteur : initialise sa valeur à
    // partir du numéro FACT le plus élevé existant (même scan qu'avant l'ancien
    // fonctionnement), mais une seule fois pour toujours — pas à chaque facture.
    // Même parade qu'avant pour les bons cuisine/bar (CUI-CMD-0001, BAR-CMD-0001)
    // qui vivent dans la même collection : ignorés via le préfixe "FACT-".
    const snap = await db.collection('factures').orderBy('createdAt', 'desc').limit(200).get();
    let maxNum = 0;
    snap.docs.forEach(doc => {
      const { numero } = doc.data();
      if (!numero || !numero.startsWith('FACT-')) return;
      const n = parseInt(numero.slice(5), 10); // slice(5) = après "FACT-"
      if (!isNaN(n) && n > maxNum) maxNum = n;
    });
    try {
      // create() échoue si le doc existe déjà : deux factures créées en même temps
      // pendant ce tout premier appel ne l'initialisent pas deux fois en écrasant
      // l'une l'autre — la seconde retombe simplement sur la valeur déjà posée.
      await counterRef.create({ value: maxNum });
    } catch { /* déjà initialisé par un appel concurrent, on repart de sa valeur */ }
  }

  const numero = await db.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef);
    const next = (doc.data()?.value || 0) + 1;
    tx.update(counterRef, { value: next });
    return next;
  });

  return `FACT-${String(numero).padStart(4, '0')}`;
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
    // La facture doit être comptabilisée le jour où la COMMANDE a été créée, pas le jour
    // où elle est validée/envoyée en caisse — sinon une commande prise hier mais facturée
    // aujourd'hui (ex. quota Firestore dépassé hier, validation reportée) se retrouve
    // comptée dans le chiffre d'affaires du mauvais jour. `commande.date` est fixé une
    // seule fois à la création (voir routes/commandes.js) et ne change jamais ensuite.
    date: commande.date || now.toISOString().split('T')[0],
    createdBy: createdBy || 'system',
    createdAt: now.toISOString(),
  };

  const ref = await db.collection('factures').add(data);
  return { facture: { id: ref.id, ...data } };
}

module.exports = { getNextNumeroFacture, createFactureFromCommande };