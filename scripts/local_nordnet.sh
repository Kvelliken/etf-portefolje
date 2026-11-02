#!/usr/bin/env bash
# Fallback hvis Nordnet blokkerer GitHubs servere: hent Nordnet-listen på egen maskin og push
# bare databasene (data/etf.db, data/fond.db), rå-HTML og data/last_fetch*.json. Kjør deretter workflowen «monthly» med
# skip_nordnet=true (eller sett repo-variabelen SKIP_NORDNET=true), så bruker Actions databasen
# i repoet og gjør resten (priser, univers, optimering, publisering).
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
python scripts/fetch_nordnet.py "$@"
python scripts/fetch_nordnet.py --fond || echo "ADVARSEL: fondslisten feilet; bare ETF-listen pushes."
git add data/etf.db data/raw data/last_fetch.json
git add data/fond.db data/raw_fond data/last_fetch_fond.json 2>/dev/null || true
if git diff --cached --quiet; then
  echo "Ingen endringer."
  exit 0
fi
summary=$(python -c "import json; d=json.load(open('data/last_fetch.json')); print(f\"{d['n_found']} ETF-er, {d['new']} nye, {d['gone']} utgått\")")
git commit -m "Nordnet hentet lokalt $(date +%F): $summary"
git push
if command -v gh >/dev/null 2>&1; then
  gh workflow run monthly.yml -f skip_nordnet=true && echo "Startet workflowen monthly med skip_nordnet=true."
else
  echo "Start workflowen «monthly» i GitHub (Actions → monthly → Run workflow) med skip_nordnet huket av."
fi
