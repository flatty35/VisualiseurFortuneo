# Portefeuille de démonstration

Jeu de fichiers **entièrement fictif** pour montrer l’appli sans données personnelles.

| Fichier | Rôle |
|---|---|
| `PEA/Export_portefeuille_detaille_099887766554.xls` | Positions ouvertes au 11/10/2026 |
| `PEA/HistoriqueOperationsBourse_099887766554_du_11_10_2024_au_11_10_2026.csv` | Historique titres (≈ 2 ans) |

- Compte fictif : `099887766554`
- Titulaire fictif : `PEA DEMO VISUALISEUR`
- Supports réels (Air Liquide, Sanofi, Vinci, …) mais **quantités, dates et montants inventés**

## Scénario

**8 positions ouvertes** à la date d’export (~ 8,7 k€).

**3 positions fermées :**

1. **RENAULT** — déjà détenue au début de la fenêtre (11/10/2024), vendue le 24/09/2025
2. **CARREFOUR** — achetée le 12/03/2025 (1re année), vendue le 14/11/2025
3. **EDENRED** — achetée le 12/03/2026 (2e année), vendue le 18/09/2026

## Import

1. Page **Import** → enveloppe PEA
2. Charger le `.xls` (positions) puis le `.csv` (historique)
3. Lancer **Auto-associer** pour résoudre les ISIN des titres vendus (`LOCAL:…`)

Régénérer : `node scripts/buildDemoPortfolio.mjs`
