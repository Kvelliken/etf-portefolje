# ETF-portefølje

Statisk side (GitHub Pages) for å finne de beste ETF-ene per sektor hos Nordnet, sette sammen et eget utvalg
med min./maks.-andeler og backteste det mot en verdens-ETF. Alt oppdateres månedlig av GitHub Actions.

**Siden:** https://kvelliken.github.io/etf-portefolje/

## Slik brukes siden

1. **Utforsker** – alle ETF-er hos Nordnet med filtre på aktivaklasse, sektor, tema, region, stil, utsteder,
   historikk, avgift, størrelse, valutasikring, utbytte og ESG. «Én per indeks» skjuler kopier av samme indeks.
   Kolonner: annualisert avkastning 1/3/5/10 år og volatilitet, Sharpe, alfa, beta, R², tracking error,
   informasjonsrate og maks fall for valgt periode. «Beste i hver gruppe» viser topp N per sektor/tema/region.
   Grafen (risiko/avkastning eller utvikling for de 10 øverste radene) følger filtrene.
2. **Mitt utvalg** – trykk + på ETF-ene du vil ha. Sett min./maks. per ETF og velg mål (maks Sharpe,
   minimum varians, risikoparitet, lik vekt eller manuelt). Vektene beregnes i nettleseren.
3. **Backtest** – utvalget mot valgt verdens-ETF (standard iShares MSCI ACWI), med faste vekter eller
   walk-forward (ny optimering hvert år/kvartal med bare data som fantes da), valgfri ombalansering og
   handelskostnad.
4. **Ombalansering** – legg inn beholdningene dine (lagres bare i nettleseren) og få kjøp/salg mot vektene fra steg 2.

Utvalg, filtre og beholdninger lagres bare i nettleseren (localStorage). «Kopier lenke» lager en lenke med
ISIN-er og grenser (ingen beløp). Ingen beholdninger eller personlige data committes noen gang.

## Arkitektur

```
Nordnet ETF-liste ─► fetch_nordnet.py ─► data/etf.db (SQLite: runs, etf_master, etf_snapshot, changes)
                                             │
                     build_prices.py ─► ticker_map (ISIN → Yahoo-ticker) ─► Yahoo-kurser + utbytte
                                             │      data/prices/close_<år>.parquet, dividends.parquet
                                             │      Norges Bank: fx.parquet (valuta), rates.parquet (styringsrente)
                                             ▼
                     build_universe.py ─► klynger av ETF-er som følger samme indeks (tracking error i NOK)
                                             │      tabell universe, data/universe/clusters.csv + report.json
                                             ▼
                     build_site.py ─► site/data/etfs.json     metadata + sektor/tema/region/stil + klynge
                                      site/data/returns.json  månedlig totalavkastning i NOK, risikofri rente
                                      site/data/summary.json, changes.json, quality.json
                                             ▼
                     site/engine.js (nøkkeltall, Ledoit-Wolf, optimering, backtest) + site/app.js (UI)
```

Nøkkeltall, optimering og backtest regnes i nettleseren, så referanse, periode og grenser kan endres på siden.

| Modul (`src/etfpf/`) | Innhold |
|---|---|
| `nordnet.py`, `db.py` | henting og parsing av Nordnet-listen, SQLite-skjema, månedlig diff (nye/utgåtte/endrede) |
| `tickers.py`, `yahoo.py` | ISIN → Yahoo-ticker (Nordnet-symbol + børs, Yahoo-søk, OpenFIGI), Yahoo-klient |
| `prices.py`, `rates.py` | Parquet-cache, rensing av feilkurser, totalavkastning i NOK, valuta og styringsrente |
| `universe.py` | én notering per ISIN, robust TE-klynging, representantvalg |
| `classify.py`, `sitedata.py` | sektor/region/tema/stil fra kategori og navn, JSON til siden |

## Fond (eksperimentelt)

Første steg mot en tilsvarende side for verdipapirfond: hent Nordnets fondsliste og mål hvor mange
fond som har brukbar kurshistorikk hos Yahoo før noe bygges videre.

```
python scripts/fetch_nordnet.py --fond --max-pages 1 --db /tmp/fond-test.db   # sjekk at fondslisten parses
python scripts/fetch_nordnet.py --fond --from-file data/raw_fond/<dato>/page_001.html.gz   # alle rå-felt
python scripts/fetch_nordnet.py --fond             # hele listen -> data/fond.db, data/raw_fond/
python scripts/probe_fund_history.py               # Yahoo-dekning for et stratifisert utvalg (200 fond)
```

Fondslisten bruker samme parser, databaseskjema og månedlige diff som ETF-listen, men egen database
(`funds` i `config.yaml`). Probe-skriptet slår opp tickere som for ETF-ene (lagres i `ticker_map` i
`data/fond.db` og gjenbrukes), og kontrollerer at tickeren er riktig andelsklasse ved å sammenligne
Yahoos kursavkastning 1 og 3 år og siste kurs med Nordnets tall. Toleransene er kalibrert på ETF-ene:
Nordnets `yield_1y` er kursavkastning i noteringsvalutaen. Et fond regnes som *brukbart* når det har
ticker, bestått kontroll og minst 3 års månedskurser. Resultat: `data/funds/probe_report.json`
(sammendrag per fondstype og domisil) og `probe_details.csv` (per ISIN).

## Kjøre lokalt

```
pip install -r requirements.txt
python scripts/fetch_nordnet.py        # Nordnet -> data/etf.db  (--max-pages 1 for rask test)
python scripts/build_prices.py         # tickere, kurser, valuta, styringsrente (første gang ca. 25 min)
python scripts/build_universe.py       # klynger av ETF-er som følger samme indeks
python scripts/build_site.py           # site/data/*.json (ca. 30 s)
python -m http.server -d site 8000     # http://localhost:8000
python -m pytest -q                    # tester (krever node for test av engine.js)
```

Det samme med `make`: `make all`, `make serve`, `make test`. Rask test uten å røre databasen:
`make nordnet-test` (én side til en midlertidig database).

## Parametere (`config.yaml`)

Alle terskler står i `config.yaml`, ikke i koden.

| Seksjon | Parameter | Betydning |
|---|---|---|
| `paths` | `db`, `raw_dir`, `price_cache`, `site_data` | hvor database, rå-HTML, priscache og sidedata ligger |
| `nordnet` | `delay_seconds`, `timeout_seconds`, `retries` | skånsom henting: pause mellom kall, tidsavbrudd, forsøk med økende ventetid |
| | `max_rounds` | nye runder hvis færre enn `total_hits` ETF-er ble funnet |
| | `min_fraction_of_previous` | sikkerhetssjekk: avbryt uten å lagre hvis færre enn 90 % av forrige aktive |
| | `raw_keep_months` | hvor mange måneder rå-HTML som beholdes (0 = alt) |
| | `list_params` | stabil sortering på navn (sideinndelingen flytter seg ikke under hentingen) |
| `account` | `type` | `ASK` eller ordinær konto; utenfor ASK vises skatteadvarsel |
| | `ask_countries` | ISIN-landkoder (EØS) som regnes som ASK-tillatt |
| | `prefer_accumulating` | foretrekk akkumulerende andelsklasse ved representantvalg |
| `tickers` | `recheck_days` | slå opp tickeren på nytt etter så mange dager |
| | `max_candidates`, `max_stale_days` | kandidater per ISIN; siste kurs må være nyere enn dette |
| | `start_slack_days`, `yahoo_history_floor` | når OpenFIGI brukes (ingen kandidat dekker fondets startdato) |
| | `nordnet_suffix`, `figi_suffix` | børskode → Yahoo-suffiks (`.DE`, `.L`, `.AS` …) |
| | `openfigi_batch`, `openfigi_delay_seconds` | OpenFIGI-grenser uten API-nøkkel |
| `prices` | `threads`, `delay_seconds`, `retries` | kall mot Yahoo |
| | `overlap_days` | hent så mange dager bakover ved inkrementell oppdatering |
| | `fx_source` | `norges_bank` (standard) eller `yahoo` |
| | `spike_ratio` | fjern kurser som avviker mer enn denne faktoren fra både kursene før og etter |
| | `jump_ratio` | kutt historikken før gjenværende døgnhopp større enn dette (0 = av) |
| `universe` | `listing_currency_preference` | foretrukket handelsvaluta når en ISIN har flere noteringer |
| | `te_threshold` | tracking error-terskel for «samme indeks» (1,0 %, valgt fra data) |
| | `te_frequency`, `te_smooth_days`, `te_window_periods` | TE på månedlig avkastning, 5-dagers snitt, siste 60 måneder |
| | `min_overlap`, `robust_te`, `robust_clip_sigma` | krav til felles historikk og robust TE (enkeltfeil dempes) |
| | `min_history_years` | minst så mange års historikk for å bli representant |
| | `exclude_categories`, `exclude_name_regex` | giret/invers/«Trading Tools» kan ikke bli representant |
| | `dist_fee_penalty`, `hysteresis_fee_pp` | utdelende regnes som dyrere på ASK; representant byttes bare ved tydelig lavere avgift |
| `site` | `benchmark_isin` | standard referanse på siden (iShares MSCI ACWI) |
| | `market_risk_premium`, `history_weight` | forventet avkastning: likevektsprior + andel historisk snitt |
| | `estimation_years` | år med månedsdata i optimeringen |
| | `default_min_weight`, `default_max_weight` | standard grenser per ETF i utvalget |
| | `trading_cost_pct` | handelskostnad i backtesten (% av handlet beløp) |
| | `rebalance_band_pp`, `portfolio_value_nok` | ombalanseringsbånd (±pp) og standard porteføljeverdi |

## GitHub Actions og Pages

* **`monthly.yml`** – første virkedag i måneden (cron 1.–3. kl. 06:17 UTC; et steg slipper bare gjennom
  første virkedag) og manuelt: tester → Nordnet → priser → univers → sidedata → commit av `data/` og
  `site/data/` med antall nye/utgåtte ETF-er i meldingen → publisering via `pages.yml`.
  Feiler et steg (sikkerhetssjekken mot Nordnet, for mange Yahoo-feil, tester), committes og publiseres
  ingenting, og GitHub sender e-post. To kjøringer kan ikke overlappe (`concurrency`).
* **`pages.yml`** – publiserer `site/` ved push til main som endrer `site/`, manuelt eller kalt fra monthly.
  Prøver én gang til ved forbigående feil i Pages-API-et, og sjekker etterpå at siden, `summary.json` og
  CDN-bibliotekene svarer. Feiler publiseringen likevel: «Re-run failed jobs» på kjøringen, eller kjør
  `pages` manuelt.
* **`validate.yml`** – tester ved push til `claude/**`-grener; manuell kjøring kan også probe datakildene.

Oppsett (én gang): *Settings → Pages → Source: GitHub Actions*. Valgfritt: repo-secret `OPENFIGI_API_KEY`
for raskere OpenFIGI-oppslag.

### Fallback hvis Nordnet blokkerer GitHub

`make local-nordnet` (`scripts/local_nordnet.sh`) henter Nordnet-listen på egen maskin, pusher bare
`data/etf.db`, rå-HTML og `data/last_fetch.json`, og starter `monthly` med `skip_nordnet=true` (krever `gh`;
ellers: *Actions → monthly → Run workflow*, huk av «skip_nordnet»). Er blokkeringen varig, sett
repo-variabelen `SKIP_NORDNET=true`, så hopper også de planlagte kjøringene over Nordnet-steget.

## Kjente begrensninger

* **Kursdata:** Yahoo Finance er en uoffisiell kilde og kan endre seg eller svikte. Feilkurser (valuta-/enhetsforveksling,
  falske nivåer) renses med regler; noen ETF-er får kuttet gammel historikk. Gårsdagens kurs mangler ofte tidlig
  om morgenen og fylles inn ved neste kjøring.
* **Ticker-dekning:** alle aktive ISIN-er har i dag ticker og kurser, men nye ETF-er kan mangle i en måned.
  ETF-er uten data vises, men har ingen nøkkeltall.
* **Survivorship bias:** bare dagens ETF-er er med, så historiske tall ser bedre ut enn et ekte univers fra fortiden.
* **Estimeringsfeil:** forventet avkastning og kovarians er usikre; optimering forsterker feilene. Siden bruker
  likevektsprior og Ledoit-Wolf, men vektene bør tas som et utgangspunkt, ikke en fasit.
* **Klassifisering:** sektor/tema er utledet fra Morningstar-kategori og navn med enkle regler og kan være feil
  for enkelte fond.
* **Kostnader:** kurtasje og valutapåslag i backtesten er forenklet; sjekk Nordnets prisliste.

## Forbehold

Modellverktøy, ikke finansiell rådgivning. Historisk avkastning er ingen garanti for fremtidig avkastning.

Hele oppdraget, avklarte valg og statusnotater per fase står i [`docs/oppdrag.md`](docs/oppdrag.md).
