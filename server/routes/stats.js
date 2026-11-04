const express = require('express');
const { db } = require('../firebase-admin');
const { authenticateToken, requireRole } = require('../middleware/auth');
const cache = require('../utils/cache');
const { formatMontant } = require('../utils/currency');
const {
  computeBilan, statsParMode, series, estVente, modeDeFacture, estSupplement,
} = require('../utils/bilan');

const { listeParPeriode, menuEnCache } = require('../utils/listes');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const router = express.Router();

// GET /api/stats/dashboard
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    // Cache partagé avec commandes/factures : invalidé par leurs écritures,
    // donc jamais périmé plus de quelques secondes après un événement SSE.
    const cached = cache.get('stats:dashboard');
    if (cached) return res.json(cached);

    const today = new Date().toISOString().split('T')[0];

    // Commandes et factures du jour : mêmes listes en cache que les pages Commandes et
    // Facturation (tenues à jour à l'écriture) — recalculer le tableau de bord après une
    // écriture ne relit donc plus la journée. Seules les commandes encore actives (pour
    // garder celles des jours précédents, rares) font l'objet d'une petite requête à part,
    // refaite après chaque écriture sur commandes/factures (voir leurs invalidate()).
    const [commandesJourListe, facturesJour, activesAnterieures] = await Promise.all([
      listeParPeriode('commandes', today, today),
      listeParPeriode('factures', today, today),
      cache.remember('commandes:actives-anterieures', 60_000, async () => {
        const snap = await db.collection('commandes').where('statut', 'in', ['en-attente', 'en-preparation']).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.date !== today);
      }),
    ]);

    // Merge and deduplicate commandes (today's + active from any date)
    const commandesMap = new Map();
    commandesJourListe.forEach(c => commandesMap.set(c.id, c));
    activesAnterieures.forEach(c => commandesMap.set(c.id, c));
    const commandes = Array.from(commandesMap.values())
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    const factures = facturesJour.filter(f => !f.type || f.type === 'facture');

    const commandesJour    = commandes.filter(c => c.date === today);
    const commandesActives = commandes.filter(c => ['en-attente', 'en-preparation'].includes(c.statut));

    const facturesPayees = factures.filter(f => f.statut === 'payee');
    const revenusJour = facturesPayees.reduce((s, f) => s + (f.total || 0), 0);

    // Ventilation du chiffre d'affaires payé du jour entre plats et boissons
    let totalPlats = 0, totalBoissons = 0;
    facturesPayees.forEach(f => {
      (f.items || []).forEach(item => {
        if (item.categorie === 'Boissons') totalBoissons += item.sousTotal || 0;
        else totalPlats += item.sousTotal || 0;
      });
    });

    const commandesParStatut = {
      'en-attente':      commandes.filter(c => c.statut === 'en-attente').length,
      'en-preparation':  commandes.filter(c => c.statut === 'en-preparation').length,
      'servie':          commandesJour.filter(c => c.statut === 'servie').length,
    };

    const result = {
      commandesJour: commandesJour.length,
      commandesActives: commandesActives.length,
      revenusJour,
      totalPlats,
      totalBoissons,
      commandesParStatut,
      // Toutes les commandes actives (en-attente/en-preparation), pas seulement celles
      // du jour : une commande bloquée depuis hier (personne ne l'a envoyée en cuisine
      // ni annulée) doit continuer à apparaître ici — sinon elle reste comptée dans
      // commandesActives ci-dessus sans jamais réapparaître dans cette liste dès que la
      // date change, ce qui donne l'impression d'un total fantôme qu'actualiser ne
      // résout jamais.
      commandesRecentes: commandesActives.slice(-5).reverse(),
    };

    cache.set('stats:dashboard', result, 60_000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/rapport?debut=YYYY-MM-DD&fin=YYYY-MM-DD
router.get('/rapport', authenticateToken, async (req, res) => {
  try {
    const { debut, fin } = req.query;

    // Période bornée : recalculé à chaque fois à partir des listes en cache (toujours à
    // jour, aucune relecture), donc jamais en retard sur une vente. Sans borne, la route
    // lit les collections en entier : résultat gardé 5 min, clé par période.
    const borne = !!(debut && fin);
    const cacheKey = `stats:rapport:${debut || ''}:${fin || ''}`;
    const cached = borne ? null : cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Période bornée : mêmes listes en cache que /bilan, /api/commandes et /api/factures
    // (tenues à jour à l'écriture, voir utils/listes.js) — le rapport et le bilan, chargés
    // ensemble par la page Rapports, ne lisent plus deux fois les mêmes documents. Sans
    // borne (historique complet), lecture directe : trop gros pour rester en mémoire.
    const lire = async (col) => {
      if (debut && fin) return listeParPeriode(col, debut, fin);
      let q = db.collection(col);
      if (debut) q = q.where('date', '>=', debut);
      if (fin)   q = q.where('date', '<=', fin);
      const snap = await q.get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    };

    const [facturesListe, commandesPeriode, menu] = await Promise.all([
      lire('factures'), lire('commandes'), menuEnCache(),
    ]);
    const factures = [...facturesListe];

    // Commandes en ligne, badgées "Client" (commandeClient) ou "Caisse" (saisie par la
    // caissière) confondues — annulées exclues, ce compteur ne reflète que le volume traité.
    const commandesEnLigneList = commandesPeriode
      .filter(c => c.source === 'en-ligne' && c.statut !== 'annulee');
    const commandesEnLigne = commandesEnLigneList.length;

    // Classement automatique sur place / à emporter (voir determineModeConsommation) :
    // uniquement renseigné sur les commandes en ligne, donc décompté sur ce même sous-ensemble.
    const commandesSurPlace   = commandesEnLigneList.filter(c => c.modeConsommation === 'sur-place').length;
    const commandesAEmporter  = commandesEnLigneList.filter(c => c.modeConsommation === 'a-emporter').length;

    const total = factures.reduce((s, f) => s + (f.total || 0), 0);
    const parMode = {};
    const parStatut = { payee: 0, partielle: 0 };

    factures.forEach(f => {
      parMode[f.modePaiement] = (parMode[f.modePaiement] || 0) + (f.total || 0);
      if (parStatut[f.statut] !== undefined) parStatut[f.statut]++;
    });

    // Ventilation par catégorie : chiffre d'affaires ET quantités vendues, pour TOUTES les
    // catégories du menu (pas seulement plats/boissons) — permet de filtrer le nombre
    // d'unités vendues d'une catégorie précise (Boissons, Accompagnement, Buffet…) sur la
    // période. Conserve aussi le classement plats/boissons existant pour compat.
    const parCategorie = {};
    const qteParCategorie = {};
    const platsVentes = {};
    const boissonsVentes = {};
    let totalPlatsQte = 0, totalBoissonsQte = 0;

    // Ventes détaillées PAR ARTICLE DU MENU : on part du catalogue actuel (pas seulement des
    // articles qui apparaissent dans une facture), pour que CHAQUE plat/boisson du menu figure
    // dans le rapport avec sa quantité vendue sur la période — 0 si rien n'a été vendu, pas
    // juste absent de la liste. Le rattachement se fait par menuItemId (fiable même si le plat
    // a été renommé depuis) ; un bucket "hors-catalogue" recueille les ventes orphelines (menu
    // item supprimé depuis, ou article ajouté sans lien catalogue) pour ne perdre aucune vente.
    const ventesParMenuItem = {};
    menu.forEach(m => {
      ventesParMenuItem[m.id] = { nom: m.nom, categorie: m.categorie || 'Autre', quantite: 0, total: 0 };
    });
    const ventesHorsCatalogue = {};

    factures.forEach(f => {
      (f.items || []).forEach(item => {
        const cat = item.categorie || 'Autre';
        parCategorie[cat] = (parCategorie[cat] || 0) + (item.sousTotal || 0);
        qteParCategorie[cat] = (qteParCategorie[cat] || 0) + (item.quantite || 0);

        const isBoisson = cat === 'Boissons';
        const ventes = isBoisson ? boissonsVentes : platsVentes;
        if (!ventes[item.nom]) ventes[item.nom] = { quantite: 0, total: 0 };
        ventes[item.nom].quantite += item.quantite || 0;
        ventes[item.nom].total   += item.sousTotal || 0;

        const cible = item.menuItemId && ventesParMenuItem[item.menuItemId]
          ? ventesParMenuItem[item.menuItemId]
          : (ventesHorsCatalogue[`${cat}||${item.nom}`] ||= { nom: item.nom, categorie: cat, quantite: 0, total: 0 });
        cible.quantite += item.quantite || 0;
        cible.total    += item.sousTotal || 0;

        if (isBoisson) totalBoissonsQte += item.quantite || 0;
        else            totalPlatsQte    += item.quantite || 0;
      });
    });

    const topVentes = (ventes) => Object.entries(ventes)
      .map(([nom, v]) => ({ nom, ...v }))
      .sort((a, b) => b.quantite - a.quantite)
      .slice(0, 5);

    const ventesDetail = [...Object.values(ventesParMenuItem), ...Object.values(ventesHorsCatalogue)]
      .sort((a, b) => b.quantite - a.quantite || a.nom.localeCompare(b.nom, 'fr'));

    // Sur place / à emporter sur TOUTES les commandes (depuis le 2026-11-01, plus seulement
    // les commandes en ligne) : mêmes factures que le reste de ce rapport, pour que ces
    // chiffres s'additionnent bien au CA affiché au-dessus. Le bilan (/bilan), lui, ne
    // compte que les factures payées.
    const commandesById = new Map(commandesPeriode.map(c => [c.id, c]));
    const ventes = factures.filter(estVente);
    // (`parMode` est déjà pris plus haut : ventilation par mode de PAIEMENT.)
    const consommation = statsParMode(ventes, commandesById);
    const { parJour, parSemaine, parMois } = series(ventes, [], commandesById, debut, fin);

    const result = {
      total,
      nombre: factures.length,
      moyenne: Math.round(total / (factures.length || 1)),
      parMode,
      parStatut,
      parCategorie,
      qteParCategorie,
      commandesEnLigne,
      commandesSurPlace,
      commandesAEmporter,
      totalPlatsQte,
      totalBoissonsQte,
      topPlats: topVentes(platsVentes),
      topBoissons: topVentes(boissonsVentes),
      ventesDetail,
      modeConsommation: { ...consommation, parJour, parSemaine, parMois },
      // Type de consommation de chaque facture (celui de sa commande) : sert à l'export.
      factures: factures.sort((a, b) => (b.date > a.date ? 1 : -1)).map(f => ({
        ...f,
        modeConsommation: modeDeFacture(f, commandesById),
        supplement: estSupplement(commandesById.get(f.commandeId)),
      })),
    };
    if (!borne) cache.set(cacheKey, result, 5 * 60_000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/bilan?debut=AAAA-MM-JJ&fin=AAAA-MM-JJ — admin uniquement.
// Entrées (factures payées) − Dépenses = Résultat, détail par jour/semaine/mois et par
// mode sur place / à emporter (calcul dans utils/bilan.js). Période obligatoire : sans
// borne, cette route relirait toutes les factures, commandes et dépenses depuis l'origine.
router.get('/bilan', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { debut, fin } = req.query;
    if (!DATE_RE.test(debut || '') || !DATE_RE.test(fin || '') || debut > fin) {
      return res.status(400).json({ error: 'Période requise : debut et fin au format AAAA-MM-JJ, debut ≤ fin' });
    }

    const cacheKey = `stats:bilan:${debut}:${fin}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Factures et commandes : listes partagées avec /rapport (même période, chargées en
    // même temps par la page Rapports) et tenues à jour à l'écriture. Dépenses : petite
    // collection, lue directement.
    const [factures, commandes, depensesSnap] = await Promise.all([
      listeParPeriode('factures', debut, fin),
      listeParPeriode('commandes', debut, fin),
      db.collection('depenses').where('date', '>=', debut).where('date', '<=', fin).get(),
    ]);

    const result = computeBilan({
      factures, commandes, depenses: depensesSnap.docs.map(d => ({ id: d.id, ...d.data() })), debut, fin,
    });
    cache.set(cacheKey, result, 2 * 60_000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/notifications
router.get('/notifications', authenticateToken, async (req, res) => {
  try {
    const cached = cache.get('stats:notifications');
    if (cached) return res.json(cached);

    const [stocksSnap, activeCommandesSnap, partiellesSnap] = await Promise.all([
      db.collection('stocks').get(),
      db.collection('commandes').where('statut', 'in', ['en-attente', 'en-preparation']).get(),
      db.collection('factures').where('statut', '==', 'partielle').get(),
    ]);

    const notifications = [];

    stocksSnap.docs.forEach(d => {
      const s = d.data();
      if (s.quantite < s.minimum) {
        notifications.push({
          type: 'warning', icon: 'boxes',
          title: 'Stock bas',
          message: `${s.nom} : ${s.quantite} / ${s.minimum} ${s.unite || ''}`,
        });
      }
    });

    const actives = activeCommandesSnap.size;
    if (actives > 0) {
      notifications.push({
        type: 'info', icon: 'fire',
        title: 'Commandes en cours',
        message: `${actives} commande(s) en attente / préparation`,
      });
    }

    if (partiellesSnap.size > 0) {
      notifications.push({
        type: 'danger', icon: 'receipt',
        title: `${partiellesSnap.size} facture(s) impayée(s)`,
        message: partiellesSnap.docs.slice(0, 3).map(d => {
          const f = d.data();
          return `${f.numero} – reste ${formatMontant(f.reste)}`;
        }).join(' | '),
      });
    }

    cache.set('stats:notifications', notifications, 30_000);
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
