# Cadence Prospection

Application de prospection pour les professionnels du droit (France, Belgique, Luxembourg, Suisse).

- **Chaque matin**, une recherche automatique trouve de nouveaux prospects qualifiés. Elle s'appuie sur l'annuaire officiel des entreprises et sur la recherche web de Claude, puis les ajoute à la base.
- **Dans l'application**, tu retrouves les messages du jour, tes prospects et ta séquence de 5 messages sur 16 jours. L'envoi se fait toi-même, en un clic, vers Gmail ou LinkedIn.

## Architecture

| Élément | Technologie | Rôle |
|---|---|---|
| Interface | React 18 + htm, construite avec Vite | Les écrans Aujourd'hui, Prospects, Séquence et Sources |
| API | FastAPI (Python 3.12) | Connexion, prospects, séquence, réglages, accroche |
| Base de données | PostgreSQL (SQLite en local) | Les prospects et la configuration |
| IA | API Claude (`claude-opus-5-5`) | L'accroche à la demande et la recherche du matin (avec recherche et lecture web) |
| Recherche du matin | `python -m app.jobs.morning` | Service cron Railway, du lundi au vendredi |

L'API sert aussi l'interface construite : il n'y a donc qu'**un seul service web** à déployer, plus le service cron.

```
frontend/              interface React (Vite)
backend/app/main.py    API FastAPI
backend/app/jobs/      recherche du matin et import JSON
Dockerfile             image unique (interface + API)
railway.json           configuration du service web
railway.cron.json      configuration du service cron
```

## Mise en ligne sur Railway

### 1. Créer le projet

1. Sur [railway.com](https://railway.com), clique sur **New Project → Deploy from GitHub repo** et choisis `cadence-prospection`.
2. Railway détecte `railway.json` et construit l'image à partir du `Dockerfile`. Le premier déploiement échouera tant que les variables de l'étape 3 ne sont pas définies : c'est normal.

### 2. Ajouter la base de données

Dans le projet, clique sur **New → Database → Add PostgreSQL**.

### 3. Configurer le service web

Dans le service `cadence-prospection`, ouvre l'onglet **Variables** et ajoute :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (référence à la base créée à l'étape 2) |
| `APP_PASSWORD` | le mot de passe que tu utiliseras pour te connecter |
| `SECRET_KEY` | une longue chaîne aléatoire, par exemple le résultat de `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | ta clé API, créée sur [console.anthropic.com](https://console.anthropic.com) |

Ensuite, va dans **Settings → Networking → Generate Domain** pour obtenir l'adresse publique de ton application.

### 4. Ajouter la recherche du matin (service cron)

1. Dans le projet, clique sur **New → GitHub Repo** et choisis à nouveau `cadence-prospection`.
2. Dans **Settings** de ce nouveau service, champ **Config-as-code / Railway Config File**, indique `/railway.cron.json`. Le service lance alors `python -m app.jobs.morning` selon le planning `43 5 * * 1-5`.
3. Dans **Variables**, ajoute `DATABASE_URL` (`${{Postgres.DATABASE_URL}}`) et `ANTHROPIC_API_KEY`.

> **Heure :** le planning est en UTC. `43 5 * * 1-5` correspond à 6 h 43 à Paris en hiver et à 7 h 43 en été. Pour garder 6 h 43 l'été, passe à `43 4 * * 1-5` fin mars.

### 5. Reprendre les prospects existants

Deux possibilités :
- **Fichier CSV :** dans l'application, onglet **Prospects → Importer un CSV**.
- **Fichier JSON** (export de l'ancienne application) : depuis ton ordinateur, avec la [CLI Railway](https://docs.railway.com/guides/cli) :

```bash
railway run --service cadence-prospection python -m app.jobs.import_json prospects.json
```

## Développement en local

```bash
cp .env.example .env    # puis remplis APP_PASSWORD, SECRET_KEY, ANTHROPIC_API_KEY
```

API (port 8000, base SQLite locale) :

```bash
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
set -a && . ../.env && set +a
COOKIE_SECURE=0 uvicorn app.main:app --reload
```

Interface (port 5173, relaie `/api` vers le port 8000) :

```bash
cd frontend
npm install
npm run dev
```

Lancer la recherche du matin à la main :

```bash
cd backend && python -m app.jobs.morning
```

Lancer les tests :

```bash
cd backend && pip install pytest && python -m pytest -q tests
```

## Réglages

| Variable | Par défaut | Effet |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | Modèle utilisé par la recherche et l'accroche |
| `MORNING_EFFORT` | `medium` | Profondeur de réflexion de la recherche du matin (`low`, `medium`, `high`) |
| `MORNING_TARGET` | `10` | Nombre de prospects cherchés chaque matin |
| `COOKIE_SECURE` | `1` | Mets `0` uniquement en local, sans HTTPS |
| `DEV_NO_AUTH` | non défini | `1` désactive la connexion, **pour le développement local uniquement** |

## Coûts

- **Railway :** l'application, la base et le cron sont facturés à l'usage. Pour un seul utilisateur, compte quelques dollars par mois.
- **API Claude :** facturée à chaque appel sur ton compte console.anthropic.com, **séparément de ton abonnement Claude**. La recherche du matin (recherches et lectures web comprises) est l'essentiel du coût, un accroche ne coûte presque rien. Surveille la page **Usage** de la console les premiers jours. Pour réduire le coût, baisse `MORNING_EFFORT` ou `MORNING_TARGET`.

## Règles respectées

- **Rien n'est envoyé automatiquement.** Les emails s'ouvrent dans Gmail, déjà rédigés, et les messages LinkedIn sont copiés pour que tu les colles toi-même.
- **Aucun email n'est inventé** par la recherche du matin : seules les adresses publiées sont reprises.
- **La source de chaque prospect est notée** dans sa fiche, pour pouvoir l'indiquer au prospect (RGPD).
