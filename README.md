# Visualiseur PEA & CTO — Fortuneo · Saxo

Application web **100 % client** pour consulter l’évolution d’un portefeuille PEA / PEA-PME / CTO à partir des exports Fortuneo.

## Fonctionnalités

- Import historiques titres + espèces + positions ouvertes
- Merge incrémental (pas d’écrasement des ops déjà connues)
- Reconstruction du portefeuille virtuel au début de la fenêtre d’historique (~2 ans)
- Graphiques (base 100, markers entrées/sorties, périodes)
- TRI sur une période (achat / revente synthétiques, sans frais d’ordre)
- Correspondances ISIN ↔ tickers Yahoo / Google / Boursorama + cours manuels
- Export / import JSON de sauvegarde
- Données personnelles **uniquement** dans IndexedDB du navigateur

## Démarrage

```bash
npm install
cp .env.example .env   # puis renseigner VITE_PROXY_URL si besoin
npm run dev
```

```bash
npm test
npm run build
```

## Proxy de cours (optionnel)

Voir [gas/README.md](gas/README.md). Sans proxy, la valorisation utilise les prix d’import / manuels / fixes.

**Privacy :** le proxy ne reçoit que des tickers et plages de dates — jamais quantités, opérations ni valorisations.

## Stack

React 19 · TypeScript · Vite · Tailwind 4 · Dexie · ECharts · PapaParse · SheetJS
