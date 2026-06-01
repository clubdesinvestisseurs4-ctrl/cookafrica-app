# Cook Africa — Application de Gestion Interne Restaurant

PWA de gestion interne pour restaurant (service sur place).  
Stack : **Vanilla JS + Express.js + Firebase Firestore** — hébergement **Vercel + Render**.

---

## Fonctionnalités

| Rôle | Accès |
|------|-------|
| **Directeur** | Dashboard global, commandes, cuisine, facturation, menu, stocks, rapports, sessions |
| **Réceptionniste** | Saisie des commandes, génération de factures, enregistrement des paiements |
| **Cuisinier** | Écran cuisine (commandes en temps réel), gestion des stocks |

### Pages de l'application

- **Dashboard** — KPIs du jour (commandes, revenus, alertes stock, commandes en cours)
- **Commandes** — saisie via panier, suivi des statuts, génération de facture
- **Écran Cuisine** — affichage temps réel des commandes, boutons "Démarrer / Prête"
- **Facturation** — génération facture avec TVA 18%, impression, enregistrement paiement
- **Menu** — gestion des plats par catégorie (Plats, Entrées, Desserts, Boissons)
- **Stocks** — gestion des ingrédients, alertes stock bas
- **Rapports** — CA, top plats, ventes par catégorie, export CSV
- **Sessions** — journal d'audit des connexions (directeur uniquement)

### Workflow commande

```
Saisie réceptionniste → [en-attente] → Cuisine démarre → [en-preparation]
→ Cuisine termine → [prête] → Réceptionniste facture → [servie] + Facture générée
```

---

## Structure du projet

```
COOKAFRICA-APP/
├── server/                       ← API Express (Node.js)
│   ├── server.js
│   ├── firebase-admin.js
│   ├── .env.example
│   ├── package.json
│   ├── render.yaml
│   ├── middleware/
│   │   └── auth.js               ← JWT + contrôle des rôles
│   ├── routes/
│   │   ├── auth.js               ← login / logout / sessions / seed
│   │   ├── commandes.js          ← CRUD commandes + écran cuisine
│   │   ├── menu.js               ← CRUD plats + seed menu
│   │   ├── factures.js           ← génération + paiement (TVA 18%)
│   │   ├── stocks.js             ← CRUD stocks + alertes + seed
│   │   ├── stats.js              ← dashboard + rapports + notifications
│   │   └── notifications.js      ← historique notifications admin
│   └── utils/
│       └── notifications.js      ← helper pushNotification
├── client/                       ← Frontend PWA (Vanilla JS)
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── sw.js                     ← Service Worker (offline)
│   ├── manifest.json
│   └── vercel.json
├── firestore.rules               ← Blocage accès direct client
├── firestore.indexes.json        ← Index composites Firestore
└── render.yaml                   ← Config déploiement Render
```

---

## Déploiement pas à pas

### Prérequis

- Compte [Firebase](https://console.firebase.google.com) (gratuit)
- Compte [Render](https://render.com) (gratuit)
- Compte [Vercel](https://vercel.com) (gratuit)
- [Git](https://git-scm.com) installé
- [Node.js 20+](https://nodejs.org) installé localement

---

### Étape 1 — Créer le projet Firebase

1. Aller sur [console.firebase.google.com](https://console.firebase.google.com)
2. Cliquer **Ajouter un projet** → nommer le projet (ex: `cookafrica-app`)
3. Désactiver Google Analytics (optionnel) → **Créer le projet**
4. Dans le menu gauche → **Firestore Database** → **Créer une base de données**
   - Sélectionner **Mode production**
   - Choisir la région (ex: `eur3` pour Europe)
5. Aller dans **Règles** → coller le contenu de `firestore.rules` → **Publier**

#### Récupérer les credentials Firebase

1. **Paramètres du projet** (icône engrenage) → **Comptes de service**
2. Cliquer **Générer une nouvelle clé privée** → confirmer → télécharger le fichier JSON
3. Garder ce fichier sous la main — il contient `project_id`, `client_email` et `private_key`

---

### Étape 2 — Déployer le backend sur Render

#### Option A — Via GitHub (recommandé)

1. Pousser le dossier `COOKAFRICA-APP/` sur un repo GitHub
2. Sur [render.com](https://render.com) → **New** → **Web Service**
3. Connecter le repo GitHub → sélectionner le repo
4. Configurer le service :
   - **Name** : `cookafrica-api`
   - **Root Directory** : `COOKAFRICA-APP/server`
   - **Environment** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `node server.js`
   - **Plan** : Free

5. Dans **Environment Variables**, ajouter :

   | Clé | Valeur |
   |-----|--------|
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | *(générer : `openssl rand -base64 32`)* |
   | `FIREBASE_PROJECT_ID` | *(depuis le JSON Firebase)* |
   | `FIREBASE_CLIENT_EMAIL` | *(depuis le JSON Firebase)* |
   | `FIREBASE_PRIVATE_KEY` | *(depuis le JSON Firebase — copier la clé entière avec les `\n`)* |
   | `CLIENT_URL` | `https://votre-app.vercel.app` *(à mettre à jour après Vercel)* |

6. Cliquer **Create Web Service** → attendre le déploiement (~2 min)
7. **Noter l'URL** du service (ex: `https://cookafrica-api.onrender.com`)

> **Important pour `FIREBASE_PRIVATE_KEY`** : dans Render, coller la valeur exactement telle qu'elle apparaît dans le JSON, entre guillemets doubles, avec les `\n` littéraux. Render gère correctement les sauts de ligne.

#### Tester le backend

```bash
curl https://cookafrica-api.onrender.com/health
# Réponse attendue : {"status":"ok","service":"Cook Africa API",...}
```

---

### Étape 3 — Configurer et déployer le frontend sur Vercel

#### Mettre à jour l'URL de l'API

Dans [client/app.js](client/app.js), ligne 7, remplacer l'URL par défaut :

```js
// Avant
: 'https://cookafrica-api.onrender.com'

// Après (votre vraie URL Render)
: 'https://cookafrica-api.onrender.com'  // déjà correct si même nom
```

#### Déployer sur Vercel

1. Sur [vercel.com](https://vercel.com) → **Add New Project**
2. Importer le repo GitHub → sélectionner le repo
3. Dans **Configure Project** :
   - **Framework Preset** : `Other`
   - **Root Directory** : `COOKAFRICA-APP/client`
4. Cliquer **Deploy** → attendre (~1 min)
5. **Noter l'URL** Vercel (ex: `https://cookafrica.vercel.app`)

#### Mettre à jour `CLIENT_URL` sur Render

Retourner sur Render → votre service → **Environment** → modifier `CLIENT_URL` avec l'URL Vercel exacte → **Save Changes** (redéploiement automatique).

---

### Étape 4 — Initialiser les données

Une fois backend et frontend déployés, initialiser la base depuis le terminal ou un client HTTP.

#### 1. Créer les utilisateurs par défaut

```bash
curl -X POST https://cookafrica-api.onrender.com/api/auth/seed
```

Réponse attendue : `{"message":"Utilisateurs créés","count":3}`

> Cette route est accessible une seule fois. Si la base contient déjà des utilisateurs, elle retourne 409.

#### 2. Se connecter et récupérer un token admin

```bash
curl -X POST https://cookafrica-api.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admincookaf@2026!"}'
```

Copier la valeur du champ `token` dans la réponse.

#### 3. Initialiser le menu (14 plats africains par défaut)

```bash
curl -X POST https://cookafrica-api.onrender.com/api/menu/seed \
  -H "Authorization: Bearer VOTRE_TOKEN_ICI"
```

#### 4. Initialiser les stocks (14 ingrédients par défaut)

```bash
curl -X POST https://cookafrica-api.onrender.com/api/stocks/seed \
  -H "Authorization: Bearer VOTRE_TOKEN_ICI"
```

> Les seeds menu et stocks peuvent aussi être lancés depuis l'interface graphique via les boutons **"Initialiser le menu"** et **"Initialiser stocks"** sur les pages correspondantes.

---

### Étape 5 — Déployer les règles Firestore (optionnel mais recommandé)

Si vous avez Firebase CLI installé :

```bash
npm install -g firebase-tools
firebase login
firebase use cookafrica-app   # votre project ID
firebase deploy --only firestore
```

Sinon, copier manuellement le contenu de `firestore.rules` et `firestore.indexes.json` dans la console Firebase.

---

## Comptes par défaut

| Rôle | Identifiant | Mot de passe |
|------|-------------|-------------|
| Directeur | `admin` | `Admincookaf@2026!` |
| Réceptionniste | `receptio` | `Receptcookaf@2026!` |
| Cuisinier | `cuisinier` | `Cuisincookaf@2026!` |
| barman    |    `barman`        | `Barmancookaf@2026!`            |

> **Changer ces mots de passe avant le déploiement en production.**  
> Modifier les valeurs dans `server/routes/auth.js` (tableau `utilisateurs`) avant d'appeler `/api/auth/seed`.

---

## Développement local

```bash
# 1. Cloner et installer les dépendances
cd COOKAFRICA-APP/server
npm install

# 2. Créer le fichier .env depuis l'exemple
cp .env.example .env
# Remplir les variables Firebase dans .env

# 3. Lancer le backend
npm run dev
# API disponible sur http://localhost:3001

# 4. Ouvrir le frontend
# Utiliser Live Server (VS Code) sur COOKAFRICA-APP/client/index.html
# ou : npx serve COOKAFRICA-APP/client
```

---

## Variables d'environnement (référence complète)

| Variable | Description | Exemple |
|----------|-------------|---------|
| `NODE_ENV` | Environnement d'exécution | `production` |
| `PORT` | Port du serveur | `10000` (Render) |
| `JWT_SECRET` | Clé secrète JWT (min. 32 chars) | `openssl rand -base64 32` |
| `FIREBASE_PROJECT_ID` | ID du projet Firebase | `cookafrica-app` |
| `FIREBASE_CLIENT_EMAIL` | Email du compte de service | `firebase-adminsdk-xxx@...` |
| `FIREBASE_PRIVATE_KEY` | Clé privée RSA du compte de service | `"-----BEGIN PRIVATE KEY-----\n..."` |
| `CLIENT_URL` | URL du frontend Vercel (pour CORS) | `https://cookafrica.vercel.app` |

---

## Collections Firestore

| Collection | Contenu |
|-----------|---------|
| `utilisateurs` | Comptes staff (username, role, passwordHash) |
| `menu` | Plats (nom, categorie, prix, disponible) |
| `commandes` | Commandes CMD-XXXX (items[], statut, total) |
| `factures` | Factures FACT-XXXX (TVA 18%, statut payee/partielle) |
| `stocks` | Ingrédients (quantite, minimum, alertes) |
| `notifications` | Historique des actions (directeur) |
| `sessions` | Journal d'audit des connexions |

---

## Notes de sécurité

- Toutes les requêtes Firestore passent **exclusivement par l'API Express** (Firebase Admin SDK)
- Le frontend ne lit jamais Firestore directement (règles bloquées)
- JWT avec expiration 12h
- Rate limiting : 200 req/15min global, 10 req/15min sur `/login`
- CORS restreint à l'URL Vercel configurée
