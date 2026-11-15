# Fond- og ETF-portefølje

Statisk side (GitHub Pages) for å sette sammen en portefølje av rentefond, indeksfond, ETF-er og spesialfond
hos Nordnet, og forstå den uten å være økonom: hva du egentlig eier, hva det koster i kroner, hvor ille det
kan gå, og om fordelingen kan bli bedre. Alt oppdateres månedlig av GitHub Actions.

**Siden:** https://kvelliken.github.io/etf-portefolje/

## Slik brukes siden

**Min portefølje** (forsiden). Legg inn sparingen din (beløp i dag, per måned, antall år), og velg fond og ETF-er:
søk, start med Forsiktig/Balansert/Offensiv, eller trykk + under *Finn fond* / *Finn ETF-er*. Sett andelen til hver.
Siden svarer så på:

1. **Hva eier jeg egentlig?** Innholdet i fondene legges sammen: «21 % av pengene dine ligger i de samme 10
   amerikanske selskapene», fordeling på land og bransjer, og om to fond eier det samme.
2. **Samme innhold, billigere tvilling.** Fond og ETF-er som eier nesten det samme som dine, men koster mindre,
   med forskjellen i kroner for sparingen din og en «Bytt»-knapp.
3. **Kostnad i kroner.** Hva kostnadene tar over årene, mot helt uten kostnader og mot de billigste tvillingene.
4. **Risiko som en historie.** «I det verste året ville 100 000 kr blitt til 82 000 kr, og det tok 1 år og 9
   måneder å komme tilbake», med grafen for akkurat din fordeling.
5. **Kan fordelingen bli bedre?** Velg risiko med en glider; forslaget er den blandingen av fondene dine som gir
   mest forventet avkastning for den risikoen. Risiko/avkastning-kartet har bakgrunn fra rødt til grønt etter Sharpe.

**Finn fond** og **Finn ETF-er** er utforskere med filtre, nøkkeltall (avkastning 1/3/5/10 år, volatilitet, Sharpe,
alfa, beta, R²) og risiko/avkastning-graf med samme Sharpe-bakgrunn. Klikk en rad for tvillinger (fond) eller
ETF-er på samme indeks.

Porteføljen, sparingen og filtrene lagres bare i nettleseren (localStorage). «Kopier lenke» lager en lenke med
ISIN-er og andeler (ingen beløp). Ingen personlige data committes noen gang.

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
                                      site/data/funds.json    fondslisten med kostnad, avkastning og risikotall
                                      site/data/innhold.json  hva hvert fond/ETF eier (fra data/holdings.db)
                                      site/data/summary.json, changes.json, quality.json
                                             ▼
                     site/engine.js   nøkkeltall, Ledoit-Wolf, effisient front (uten DOM)
                     site/insight.js  kostnad i kroner, risikohistorie, likhet/tvillinger, gjennomlysning (uten DOM)
                     site/portefolje.js (Min portefølje) · fond.js (Finn fond) · app.js (Finn ETF-er, felles)
```

Alle beregninger gjøres i nettleseren, så andeler, sparing og risiko kan endres på siden.

| Modul (`src/etfpf/`) | Innhold |
|---|---|
| `nordnet.py`, `db.py` | henting og parsing av Nordnet-listen, SQLite-skjema, månedlig diff (nye/utgåtte/endrede) |
| `tickers.py`, `yahoo.py` | ISIN → Yahoo-ticker (Nordnet-symbol + børs, Yahoo-søk, OpenFIGI), Yahoo-klient |
| `prices.py`, `rates.py` | Parquet-cache, rensing av feilkurser, totalavkastning i NOK, valuta og styringsrente |
| `universe.py` | én notering per ISIN, robust TE-klynging, representantvalg |
| `classify.py`, `sitedata.py` | sektor/region/tema/stil fra kategori og navn, JSON til siden |
| `funddata.py`, `fundprobe.py` | fond-fanens data (`funds.json`) og målingen av Yahoo-dekning for fond |
| `funddetails.py` | risikotall per fond fra Nordnet (volatilitet, Sharpe, alfa, beta i NOK; R² fra Morningstar) |
| `holdings.py` | innholdet i fond og ETF-er fra Nordnet: land, bransjer, aktivaklasser og største beholdninger |

## Innhold, tvillinger og historikk for fond

* **Innhold** (`scripts/fetch_holdings.py` → `data/holdings.db` → `site/data/innhold.json`): Nordnets fond-API
  (`api/2/instruments/<id>/fund/info`, uten innlogging, virker for både fond og ETF-er) gir fordeling på land,
  bransjer og aktivaklasser og de 25–35 største beholdningene (Morningstar). Navnene slås opp med
  `api/2/instruments/<id,id,…>`. Beholdninger Nordnet ikke har som instrument (de fleste obligasjoner) mangler, så
  andelen i enkeltselskaper er et minimum.
* **Tvillinger**: minst 90 % felles landfordeling, 85 % felles bransjefordeling og 60 % overlapp i de største
  beholdningene, samme aktivaklasse og valutasikring (tersklene står øverst i `site/portefolje.js`). ETF-er i
  samme klynge (samme indeks) er alltid tvillinger. Rentefond sammenlignes på kategori, valuta og volatilitet.
* **Historikk for fond**: Nordnet gir ikke kurshistorikk for fond, og Yahoo dekker dem dårlig (probe 2026-11:
  4 % har 5 år). Risikohistorien og forslaget trenger månedsavkastning, så et fond låner månedsmønsteret fra
  ETF-en med likest innhold, skalert til fondets egen volatilitet og forskjøvet slik at de siste 5 (3/1) årene
  gir nøyaktig fondets egen avkastning (Nordnets tall). Norske rentefond anslås fra styringsrenten pluss fondets
  egen meravkastning og volatilitet. Slike fond er merket «historikk anslått» på siden.
* **Fondstallene** (kostnad = forvaltningshonorar − returprovisjon + plattformavgift; avkastning 1/3/5/10 år i NOK
  etter kostnader; volatilitet, Sharpe, alfa, beta i NOK; R² fra Morningstar) er som før, se `funddata.py` og
  `funddetails.py`.

```
python scripts/fetch_nordnet.py --fond             # fondslisten -> data/fond.db, data/raw_fond/
python scripts/fetch_fund_details.py               # risikotall per fond -> fund_details i data/fond.db (~75 min)
python scripts/fetch_holdings.py                   # innhold i fond og ETF-er -> data/holdings.db (~45 min)
python scripts/build_site.py                       # skriver også site/data/funds.json når data/fond.db finnes
make fond-test                                     # én side til en midlertidig database + feltrapport
make fond-probe                                    # Yahoo-dekning for et stratifisert utvalg (200 fond)
```

Fondslisten bruker samme parser, databaseskjema og månedlige diff som ETF-listen, men egen database
(`funds` i `config.yaml`). Probe-skriptet slår opp tickere som for ETF-ene (lagres i `ticker_map` i
`data/fond.db`) og kontrollerer andelsklassen ved å sammenligne Yahoos avkastning 1 og 3 år (omregnet til NOK)
og siste kurs med Nordnets tall. Resultat 2026-11 (200 fond): ticker 98 %, ≥ 3 år 62 %, ≥ 5 år 4 %,
andelsklasse ok 67 %, brukbar 46 %. Rapport: `data/funds/probe_report.json` og `probe_details.csv`.

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
| `funds` | `url`, `db`, `raw_dir`, `last_fetch` | Nordnets fondsliste og hvor fonddataene lagres (henteparametere fra `nordnet`) |
| | `probe.sample`, `probe.tol_1y_pp`, `probe.tol_3y_pp`, `probe.price_ratio_tol` | utvalg og toleranser for `make fond-probe` |
| | `details.refresh_days`, `details.delay_seconds`, `details.pages` | risikotall per fond: hent på nytt etter N dager, pause per kall, hent fondssiden (R²) |
| | `holdings.db`, `holdings.refresh_days`, `holdings.delay_seconds`, `holdings.threads` | innhold i fond og ETF-er: database, hent på nytt etter N dager, pause og samtidige kall |
| `account` | `type` | `ASK` eller ordinær konto; utenfor ASK vises skatteadvarsel |
| | `ask_countries` | ISIN-landkoder (EØS) som regnes som ASK-tillatt (`"NO"` i anførselstegn, ellers leser YAML det som false) |
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
| | `estimation_years` | år med månedsdata bak samvariasjon og forslag |
| | øvrige (`default_*_weight`, `trading_cost_pct`, `rebalance_band_pp`, `portfolio_value_nok`) | fra den gamle optimeringen/backtesten; brukes ikke av siden lenger |

## GitHub Actions og Pages

* **`monthly.yml`** – første virkedag i måneden (cron 1.–3. kl. 06:17 UTC; et steg slipper bare gjennom
  første virkedag) og manuelt: tester → Nordnet (ETF-er, så fond, risikotall per fond og innhold i fond/ETF-er;
  fonds- og innholdsstegene er ikke kritiske og gir bare en advarsel hvis de feiler) → priser → univers → sidedata → commit av `data/` og
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
* **Fond uten kurshistorikk:** risikohistorien for fond er et anslag (se over). For indeksfond er det treffsikkert,
  for aktive fond og rentefond grovere.
* **Kostnader:** kurtasje, kursforskjell og valutapåslag for ETF-er er ikke med i kroneregnestykket; sjekk Nordnets prisliste.

## Forbehold

Modellverktøy, ikke finansiell rådgivning. Historisk avkastning er ingen garanti for fremtidig avkastning.

Hele oppdraget, avklarte valg og statusnotater per fase står i [`docs/oppdrag.md`](docs/oppdrag.md).
