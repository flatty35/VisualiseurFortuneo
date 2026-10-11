# Proxy Yahoo — Visualiseur Fortuneo

Script Google Apps Script **indépendant**, écrit pour ce projet. Il expose uniquement des cours de marché publics.

## Contrat privacy

Le proxy **ne doit jamais** recevoir :

- quantités, PRU, valorisations, cash
- opérations ou libellés de compte
- ISIN liés à un portefeuille (avec montants)
- e-mail, user id, ou toute donnée personnelle

Paramètres autorisés : `action`, `ticker` / `tickers`, `days`, `period1`, `period2`, `q` (nom / ISIN / ticker publics uniquement).

## Déploiement

1. [script.google.com](https://script.google.com) → Nouveau projet
2. Coller le contenu de `YahooProxy.gs`
3. Déployer → Nouveau déploiement → **Application Web**
   - Exécuter en tant que : **Moi**
   - Qui peut y accéder : **Tout le monde**
4. Copier l’URL `/exec` dans `.env` :

```env
VITE_PROXY_URL=https://script.google.com/macros/s/XXXX/exec
```

5. Redémarrer `npm run dev`

## Endpoints

| action | params | réponse |
|--------|--------|---------|
| `price` | `ticker` | `{ price }` |
| `bulk` | `tickers=A,B` | `{ prices: { A, B } }` |
| `history` | `ticker` + `days` **ou** `period1`/`period2` | `{ bars: [{ date, close }] }` — Yahoo, sinon Boursorama EOD |
| `historybulk` | `tickers=A,B,…` + `period1`/`period2` | `{ histories: { A: bars, B: bars } }` — Yahoo `fetchAll` + fallback Boursorama si vide |
| `search` | `q` (nom ou ISIN public) | `{ quotes: [{ symbol, … }] }` |
| `openfigi` | `q` = ISIN, optionnel `venues=pa-am` | `{ ticker, exchCode }` (PAR → `.PA`, NA → `.AS`) |
| `openfigibatch` | `isins=ISIN1,ISIN2,…` (max ~100) | `{ results: [{ isin, ticker?, exchCode? }] }` — **Paris/Amsterdam uniquement** |
| `openfigisearch` | `q` = nom | `{ results: [{ ticker, name, … }] }` (OpenFIGI `/v3/search`) |
| `isinsearch` | `q` = nom ou ticker | `{ results, debug }` — Morningstar si possible, sinon OpenFIGI + Boursorama. **Note :** Morningstar renvoie souvent 403 depuis les IP Apps Script ; en local l’app utilise aussi le proxy Vite `/api/morningstar`. |
| `quotemeta` | `ticker` | `{ symbol, isin?, … }` (ISIN via Boursorama) |

Cache : `CacheService` (live ~5 min, history ~6 h). Les clés chart Yahoo sont un **MD5 de l’URL complète** (`ych5:…`) — ne pas tronquer, sinon `period1`/`period2` sont ignorés et un delta 5j peut polluer une requête 2 ans.

**Important :** après chaque modification de `YahooProxy.gs`, créez un **nouveau déploiement** (nouvelle version). Puis dans l’app : **Rafraîchir cours** (le cache IndexedDB local peut encore contenir une série courte empoisonnée).
