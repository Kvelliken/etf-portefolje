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
ISIN-er og grenser (ingen beløp).

## Arkitektur

```
Nordnet ETF-liste ─► data/etf.db ─► ticker-mapping + Yahoo-kurser ─► data/prices/*.parquet
                                                                       │  (+ Norges Bank: valuta, styringsrente)
                     build_universe.py (klynger av samme indeks) ◄─────┘
                                   │
                     build_site.py ─► site/data/etfs.json     metadata + sektor/tema/region/stil
                                      site/data/returns.json  månedlig totalavkastning i NOK, risikofri rente
                                   │
                     site/engine.js (nøkkeltall, Ledoit-Wolf, optimering, backtest) + site/app.js (UI)
```

Nøkkeltall, optimering og backtest regnes i nettleseren, så referanse, periode og grenser kan endres på siden.

## Kjøre lokalt

```
pip install -r requirements.txt
python scripts/fetch_nordnet.py        # Nordnet -> data/etf.db  (--max-pages 1 for rask test)
python scripts/build_prices.py         # tickere, kurser, valuta, styringsrente
python scripts/build_universe.py       # klynger av ETF-er som følger samme indeks
python scripts/build_site.py           # site/data/*.json (ca. 30 s)
python -m http.server -d site 8000     # http://localhost:8000
python -m pytest -q                    # tester (krever node for test av engine.js)
```

Alle parametere står i `config.yaml` (seksjonen `site:` har standardverdiene på siden: referanse,
risikopremie, andel historikk, estimeringsvindu, standard min./maks. og handelskostnad).

Den gamle automatiske modellen (frontier over alle representanter, bootstrap, walk-forward over hele universet)
finnes fortsatt som `scripts/build_model_legacy.py`, men brukes ikke av siden.

## GitHub Actions

* `monthly.yml` – første virkedag i måneden: Nordnet → priser → univers → sidedata → commit → Pages.
  `skip_nordnet` bruker databasen i repoet (fallback: `make local-nordnet` henter Nordnet lokalt).
* `pages.yml` – publiserer `site/` ved push til main.
* `validate.yml` – tester ved push til `claude/**`-grener.

## Forbehold

Modellverktøy, ikke finansiell rådgivning. Historisk avkastning er ingen garanti for fremtidig avkastning.
Kurser fra Yahoo Finance er uoffisielle. Bare dagens ETF-er er med (survivorship bias). Sektor/tema er utledet
fra Morningstar-kategori og navn med enkle regler og kan være feil for enkelte fond.
