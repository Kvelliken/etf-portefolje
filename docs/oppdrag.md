# Oppdrag: ETF-porteføljeverktøy med Nordnet-data, GitHub Actions og GitHub Pages

> Opprinnelig oppdragstekst (7. oktober 2026). Avklarte valg og avvik står nederst.

Du skal bygge et komplett GitHub-repo som (1) henter hele ETF-universet fra Nordnet, (2) reduserer det automatisk til unike eksponeringer, (3) henter prishistorikk og beregner en effisient frontier og en anbefalt portefølje, og (4) publiserer resultatet som en statisk side på GitHub Pages som jeg bruker til å rebalansere månedlig eller kvartalsvis. Alt skal kjøre automatisk via GitHub Actions.

Brukergrensesnitt og tekst på siden skal være på norsk (bokmål). Kode, variabelnavn og kommentarer kan være på engelsk.

Målet mitt: finne ETF-er som gir god diversifisering og mest mulig avkastning til lavest mulig risiko, uten manuell utvelgelse av universet.

## 0. Arbeidsmåte

* Start med å lese hele denne prompten. Lag en plan med faser (se seksjon 9) og vis den før du skriver mye kode. Spør meg hvis noe er uklart eller motstridende.
* Opprett repoet med `gh repo create` (foreslå navn, f.eks. `etf-portefolje`). Spør om det skal være offentlig eller privat. Merk: GitHub Pages på privat repo krever betalt plan.
* Bygg i små, testbare steg. Skriv tester med fixtures (lagrede HTML-/prisutdrag) slik at parsing og beregninger kan testes uten nett.
* Python 3.11+, avhengigheter i `requirements.txt` (eller `pyproject.toml`). Hold det enkelt.
* Jeg har allerede et fungerende henteskript, `nordnet_etf.py`, som jeg legger i repoet (eller limer inn). Bruk det som utgangspunkt og refaktorer det inn i strukturen under. Alt det gjør er beskrevet i seksjon 2, så du kan også skrive det på nytt.

## 1. Foreslått repostruktur

```
etf-portefolje/
├── src/etfpf/
│   ├── nordnet.py          # henting + parsing av Nordnet-listen
│   ├── db.py               # SQLite-skjema, lagring, diff
│   ├── tickers.py          # ISIN -> Yahoo-ticker (OpenFIGI + børssuffiks)
│   ├── prices.py           # prishistorikk (yfinance), valuta til NOK, cache
│   ├── universe.py         # dedup, tracking-error-klynging, representantvalg
│   ├── optimize.py         # frontier, porteføljer, backtest
│   └── export.py           # skriver site/data/*.json
├── scripts/
│   ├── fetch_nordnet.py    # CLI: henter Nordnet -> etf.db
│   ├── build_universe.py   # CLI: priser + klynging -> etf.db
│   └── build_site.py       # CLI: optimering + JSON-eksport
├── site/                   # statisk side (GitHub Pages)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── data/               # genererte JSON-filer
├── data/
│   ├── etf.db              # SQLite (committes, se seksjon 7)
│   └── raw/<dato>/         # gzippet rå-HTML fra Nordnet
├── tests/
├── config.yaml             # alle terskler og parametere
└── .github/workflows/
    ├── monthly.yml
    └── pages.yml
```

Alle terskler (tracking error, vektgrenser, historikkrav, rebalanseringsbånd osv.) skal ligge i `config.yaml`, ikke hardkodet.

## 2. Nordnet-henting (dette har vi allerede kartlagt og testet)

### Fakta fra testene

* URL: `https://www.nordnet.no/etf/liste`. Vanlig `requests.get` med `User-Agent: Mozilla/5.0` gir HTTP 200 og ca. 2 MB HTML. Ingen innlogging nødvendig.
* Siden viser 2 253 ETF-er, 100 per side, dvs. 23 sider.
* Paginering: `?page=2`, `?page=3` osv. fungerer (side 2 ga 98 nye ISIN-er). `?offset=` og `?limit=` fungerer ikke (ga samme innhold som side 1).
* Et gjettet internt API-endepunkt (`/api/2/instrument_search/query/etflist?...`) ga 401. Ikke bruk API-et, bruk HTML-siden.
* Dataene ligger som escapet JSON inne i et script i HTML-en (ikke `__NEXT_DATA__`). Utdrag:

```
\"data\":{\"etflist?limit=100&sort_attribute=yield_1y&sort_order=desc\":{\"rows\":100,\"total_hits\":2253,\"results\":[{\"instrument_info\":{\"instrument_id\":17059750,\"name\":\"Franklin FTSE Korea UCITS ETF\",\"long_name\":\"Franklin FTSE Korea UCITS ETF\",\"symbol\":\"FLXK\",\"instrument_group_type\":\"PAR\",\"instrument_type_hierarchy\":\"WNT/PAR/UETF\",\"instrument_type\":\"UETF\",\"isin\":\"IE00BHZRR030\",\"currency\":\"EUR\",\"price_unit\":\"EUR\",\"clearing_place\":\"PERS_DE\",\"is_tradable\":true,\"instrument_pawn_percentage\":70,\"is_shortable\":false,\"issuer_id\":257377,\"issuer_name\":\"Franklin Templeton\",\"is_monthly_saveable\":false,\"is_monthly_save_dask\":false,\"mifid2_id\":0,\"instrument_icon_url\":\"https://...
```

* Hver rad har altså `instrument_info` med bl.a. `instrument_id`, `name`, `long_name`, `symbol` (Nordnets ticker), `isin`, `currency`, `clearing_place`, `issuer_name`, `is_tradable`, `is_monthly_saveable`. Det finnes trolig flere objekter per rad (avkastning, avgift, kategori, risiko, Morningstar-rating, antall eiere, utbyttepolicy osv., som vises i tabellen på siden). Undersøk en lagret side og ta med alle nyttige felt, særlig: kategori, årlig avgift (ongoing charge), antall eiere, utbyttepolicy (akk./utd.), risiko, rating, fondsstørrelse hvis tilgjengelig, og om ETF-en er tillatt på aksjesparekonto (ASK) hvis det finnes et felt for det.
* Detaljsider har URL-form `/etf/liste/<navn-slug>-<ticker>-<børs>`, f.eks. `/etf/liste/amundi-msci-korea-ucits-lkor-xeta` (`xeta` = Xetra). Detaljsider skal bare brukes hvis et nødvendig felt mangler i listen.
* Duplikater: Samme ISIN kan forekomme flere ganger (ulike handelsplasser/valutaer). På side 1 var det 99 unike ISIN-er på 100 rader. Primærnøkkel er derfor `instrument_id`, ikke ISIN.
* Listen er sortert på 1-års avkastning, så rader kan flytte seg mellom sider under hentingen. Løsning: dedupliser på `instrument_id`, og ta en ny runde hvis antall < `total_hits` (maks 3 runder). Vurder å finne en stabil sortering via URL-parametere (f.eks. sortering på navn) og test det.

### Krav til henteren

* Parsing: fjern escaping (`\"` → `"`), og trekk ut hvert `instrument_info`-objekt. Gjør gjerne robust JSON-parsing av hele `results`-arrayen i stedet for regex hvis mulig. Valider ISIN-format `^[A-Z]{2}[A-Z0-9]{9}[0-9]$`.
* Skånsom henting: ca. 1,5 sekunder mellom kall, retry med backoff ved feil/429, timeout 45 sekunder. Hele jobben er bare 23 kall.
* Lagre rå-HTML gzippet i `data/raw/<YYYY-MM-DD>/page_NNN.html.gz`, slik at nye felt kan hentes ut senere uten ny scraping. Vurder å bare beholde de siste N månedene for å holde repoet lite.
* Sikkerhetssjekk: Hvis en full kjøring finner < 90 % av antallet aktive ETF-er fra forrige kjøring, skal ingenting lagres, og jobben skal feile tydelig (siden har sannsynligvis endret seg). Det samme gjelder hvis 0 rader parses.
* `--max-pages N` for test og `--from-file` for å teste parsing mot lagret HTML.
* Jeg skal se over Nordnets vilkår selv, men hold forespørselsraten lav.

### Database (SQLite, `data/etf.db`)

Minimum disse tabellene (utvid ved behov):

* `runs(run_id, run_at, total_hits, n_found)`
* `etf_master(instrument_id PK, isin, symbol, name, long_name, currency, clearing_place, issuer_name, instrument_type, category, fee, ... , first_seen, last_seen, active, delisted_at)`
* `etf_snapshot(run_id, instrument_id, <alle nøkkeltall fra listen>)` – én rad per ETF per kjøring, slik at vi bygger egen historikk på avgifter, antall eiere osv.
* `changes(run_id, instrument_id, change, field, old, new)` med `change` ∈ `new`, `gone`, `reappeared`, `changed`.

### Månedlig diff

Sammenlign med forrige kjøring: nye ETF-er, utgåtte (finnes ikke lenger), tilbakekomne og endrede felt (navn, ticker, avgift, valuta osv.). Utgåtte ETF-er slettes ikke, men får `active=0` og `delisted_at`. Delvise kjøringer (`--max-pages`) skal aldri markere noe som utgått.

## 3. ISIN → ticker → prishistorikk

* Prisdata hentes fra andre kilder enn Nordnet, primært yfinance (uoffisiell kilde, kan svikte; bygg inn retry, cache og tydelig logging).
* Det vanskeligste er å oversette ISIN til en Yahoo-ticker med riktig børssuffiks (`.DE` Xetra, `.L` London, `.AS` Amsterdam, `.PA` Paris, `.MI` Milano, `.SW` Sveits, `.ST` Stockholm, `.OL` Oslo osv.). Bruk:
   1. Nordnets `symbol` + `clearing_place`/børs fra URL-en (f.eks. `xeta` → `.DE`) som første forsøk.
   2. OpenFIGI API (gratis, ISIN-oppslag) som oppslag/fallback. Dekningen er ikke testet.
   3. Lagre mappingen i en tabell `ticker_map(isin, yahoo_ticker, source, verified_at, ok)` slik at den ikke må slås opp hver måned. Prøv flere kandidater per ISIN og velg den med lengst og mest komplett historikk.
* Rapporter dekningen (hvor mange ISIN-er som fikk prisdata). ETF-er uten data faller ut av optimeringen. Det er greit, men skal vises på siden.
* Bruk justerte kurser (totalavkastning), ellers straffes utdelende fond.
* Regn alt i NOK: konverter fra fondets handelsvaluta til NOK med daglige valutakurser (f.eks. `EURNOK=X`, `USDNOK=X`, `SEKNOK=X` fra yfinance, eller Norges Banks API). Valutarisiko er en del av min risiko.
* Cache prisdata lokalt/i repoet (f.eks. Parquet) og hent bare nye datoer ved hver kjøring.

## 4. Automatisk reduksjon av universet (ingen manuell utvelgelse)

Dette er et absolutt krav: universet skal reduseres automatisk, basert på data og ikke på navn.

### Lag 1 – eksakte duplikater

Grupper på ISIN og behold én notering per ETF (foretrukket: handlebar notering med lavest kostnad/best likviditet, gjerne i NOK eller EUR).

### Lag 2 – samme indeks, målt med tracking error

* Beregn ukentlig avkastning i NOK (ukentlig demper støy fra ulike børstider/asiatiske markeder).
* For hvert par ETF-er: tracking error = årlig standardavvik av differansen i avkastning. Regn alle par vektorisert fra kovariansmatrisen: `TE²_ij = var_i + var_j − 2·cov_ij` (annualisert). Bruk bare overlappende perioder, og krev et minimum antall felles observasjoner.
* Samme indeks i ulike innpakninger (iShares, Amundi, Xtrackers osv.) har typisk TE godt under 0,5–1 %. Ulike, men like indekser (f.eks. S&P 500 vs. MSCI World) har flere prosent. Bruk tracking error, ikke korrelasjon, fordi korrelasjonen mellom S&P 500 og MSCI World er så høy at en korrelasjonsterskel enten slår dem sammen eller slipper gjennom duplikater.
* Hierarkisk klynging med complete linkage på TE-avstand, terskel konfigurerbar (start på 0,75 %, test 0,5 % og 1 %). Complete linkage unngår kjedeeffekten der A ligner B og B ligner C, men A ikke ligner C.
* Navnenormalisering (fjern utstedernavn, «UCITS ETF», «Acc/Dist», «(USD)» osv.) brukes kun som kontroll, f.eks. en rapport over klynger der navnene spriker mye eller der nesten like navn havnet i ulike klynger.
* Lag en kolonne `hedged` (fra navn/data). Valutasikret og usikret versjon av samme indeks er ulik eksponering i NOK og skal normalt havne i ulike klynger. Det er riktig oppførsel.
* Nesten-duplikater som MSCI Korea vs. FTSE Korea slås kanskje ikke sammen ved 0,75 %. Det håndteres i optimeringen med tak per kategori/region (seksjon 5), ikke med en løsere terskel.

### Lag 3 – velg én representant per klynge (regelbasert)

1. Harde filtre: handlebar på Nordnet, minst 5 års historikk (konfigurerbart, helst 10), ikke giret/invers (ekskluder kategorien «Trading Tools» og navn med «Leveraged», «2x», «Daily Short» osv.).
2. Rangering: lavest årlig avgift → størst/mest likvid (fondsstørrelse hvis tilgjengelig, ellers antall eiere hos Nordnet som proxy) → lengst historikk.
3. Foretrekk akkumulerende hvis `config.yaml` sier at kontoen er ASK.
4. Stabilitet (hysterese): Behold forrige måneds representant med mindre en annen ETF er tydelig bedre (f.eks. minst 0,05 pp. lavere avgift), slik at valget ikke hopper frem og tilbake.

Ingenting slettes. Lagre i databasen: `cluster_id`, `is_representative`, `cluster_size` og årsak til valget. Siden skal kunne vise «alternativer til denne ETF-en».

### Akseptansetest for klyngingen

* Alle Korea-ETF-er som følger samme indeks (f.eks. de flere MSCI Korea-ETF-ene fra Amundi, iShares og Xtrackers) skal havne i samme klynge. Det samme gjelder MSCI Taiwan.
* S&P 500 og MSCI World skal ikke havne i samme klynge.
* Skriv ut en klyngerapport (CSV/JSON) med alle klynger > 1 medlem, slik at jeg kan sjekke resultatet stikkprøvevis.

## 5. Optimering og risikomodell

* Bibliotek: PyPortfolioOpt eller Riskfolio-Lib (velg ett og begrunn valget).
* Ikke bruk naiv historisk gjennomsnittsavkastning som forventet avkastning. Klassisk mean-variance forsterker estimeringsfeil (i dag ville Korea-ETF-ene med +140 % siste år dominert). Bruk:
   * Ledoit-Wolf shrinkage for kovarians.
   * Robuste avkastningsestimater: f.eks. Black-Litterman med markedsvekter/likevekt som prior, eller shrinkage mot et felles snitt.
   * Alternative porteføljer som ikke trenger avkastningsestimater: minimum varians, risk parity og HRP (Hierarchical Risk Parity).
* Begrensninger (alle i `config.yaml`): ingen short, maks 20–25 % per ETF, minimumsvekt (f.eks. 2 %, ellers 0) for å unngå bittesmå posisjoner, maks antall ETF-er (f.eks. 5–15), tak per kategori/region, og eventuelt maks samlet avgift.
* Beregn effisient frontier (f.eks. 50 punkter) og marker: minimum risiko, maks Sharpe (risikofri rente = norsk rente, f.eks. NIBOR/statskasseveksler, konfigurerbar), risk parity, HRP og min nåværende portefølje.
* Usikkerhet: bootstrap (f.eks. 200 resamplinger av avkastningshistorikken) for å vise et bånd rundt frontieren og hvor stabile vektene er.
* Walk-forward backtest: vekter beregnes kun med data tilgjengelig på hvert tidspunkt, med rebalansering etter regelen. Sammenlign mot referanse (en bred global indeks-ETF, f.eks. MSCI World/ACWI, konfigurerbar). En vanlig in-sample backtest ser altfor bra ut og skal ikke være hovedvisningen.
* Rebalanseringsfrekvens etter kostnader: sammenlign månedlig, kvartalsvis, årlig og avviksbasert (handle bare når en vekt avviker mer enn ±5 pp. fra målet). Ta med kurtasje (konfigurerbar, Nordnets prisliste) og spread. Vis resultatet, siden månedlig rebalansering ofte er for hyppig.
* Skatt: rebalansering er enklest på aksjesparekonto (ASK). Utenfor ASK utløser salg gevinstskatt. Legg inn et konfigurerbart flagg og vis en advarsel, men ikke bygg full skatteberegning.

## 6. Nettsiden (GitHub Pages)

Statisk side uten server: `index.html` + JS som leser `site/data/*.json`. Bruk Plotly.js eller ECharts til grafer og Tabulator til tabeller (via CDN med låst versjon). Siden skal fungere på mobil, ha mørk og lys modus, være rask og ha norsk tekst og tallformat (komma som desimaltegn, mellomrom som tusenskille).

Seksjoner i prioritert rekkefølge (beslutning først, så bevis):

1. Toppfelt med nøkkeltall for anbefalt portefølje: forventet avkastning, volatilitet, Sharpe, maks drawdown, vektet årlig avgift, antall ETF-er og dato for siste oppdatering (data og kjøring).
2. Effisient frontier (scatter): risiko (x) og avkastning (y), frontierlinjen med bootstrap-bånd, alle representant-ETF-er som små grå prikker (hover viser navn, ticker, ISIN, avgift), og markerte porteføljer (min. risiko, maks Sharpe, risk parity, HRP, nåværende, referanse). Mulighet for å velge et punkt på frontieren og se vektene.
3. Anbefalt portefølje: tabell (ticker, ISIN, navn, vekt, avgift, valuta, kategori/rolle, akk./utd., lenke til Nordnet-siden) + søylediagram eller smultring over vekter. Velger for porteføljetype (maks Sharpe / min. varians / risk parity / HRP).
4. Rebalanseringstabell: jeg legger inn mine nåværende beholdninger (antall andeler eller beløp per ETF) og totalbeløp i nettleseren. De lagres kun i `localStorage`, aldri i repoet. Tabellen viser nåværende vekt, målvekt, avvik og kjøp/salg i kroner og antall andeler. Marker «ingen handel nødvendig» når alt er innenfor båndet (±5 pp., konfigurerbart). Mulighet for å eksportere/importere beholdninger som JSON-fil.
5. Risiko: korrelasjonsmatrise (heatmap) for porteføljens ETF-er, risikobidrag per ETF (søyle) og drawdown-graf («under vann»).
6. Backtest: kumulativ avkastning (walk-forward) mot referanse, og tabell som sammenligner rebalanseringsfrekvenser etter kostnader.
7. ETF-utforsker: sorterbar og filtrerbar tabell over hele universet (alle aktive ETF-er) med kolonner for avgift, historikklengde, CAGR, volatilitet, Sharpe, maks drawdown, kategori, valuta, utsteder, antall eiere, `cluster_id`, om den er representant, og «alternativer i samme klynge» (ekspanderbar rad). Søk på navn/ticker/ISIN.
8. Endringslogg: nye, utgåtte og endrede ETF-er per månedlig kjøring (fra `changes`-tabellen), samt endringer i anbefalte vekter siden forrige kjøring.
9. Datakvalitet: antall ETF-er hos Nordnet, antall med ticker-mapping, antall med nok historikk, antall klynger/representanter.
10. Metode og forbehold nederst: kort forklaring av metoden, datakilder og at dette er et modellverktøy og ikke finansiell rådgivning, og at historisk avkastning ikke garanterer fremtidig avkastning.

Bruk dataviz-prinsipper: tydelige akser med enheter (%), konsekvente farger for porteføljetyper på tvers av alle grafer, og ingen fargebruk alene for å bære mening.

## 7. GitHub Actions og Pages

* `monthly.yml`: kjøres på cron (f.eks. første virkedag i måneden ca. kl. 06 UTC) og med `workflow_dispatch` for manuell kjøring. Steg: installer avhengigheter → `fetch_nordnet.py` → `build_universe.py` → `build_site.py` → commit oppdatert `data/` (db, priscache, rå-HTML) og `site/data/` med en beskrivende melding (antall nye/utgåtte ETF-er) → deploy.
* `pages.yml` (eller samme workflow): deploy `site/` til GitHub Pages med `actions/upload-pages-artifact` og `actions/deploy-pages`. Sett riktige `permissions`.
* Bruk caching av pip og priscache. Sett `concurrency` så to kjøringer ikke overlapper.
* Feilhåndtering: Hvis sikkerhetssjekken i seksjon 2 slår ut eller yfinance svikter for mange tickere, skal jobben feile tydelig og ikke overskrive forrige gode data eller side. GitHub varsler meg da på e-post.
* Kjent risiko: Nordnet kan blokkere GitHubs servere (ikke testet). Lag derfor en fallback: et lokalt skript/`make`-mål jeg kan kjøre på egen maskin som henter Nordnet-data og pusher kun `data/etf.db` (og rå-HTML), og la Actions-jobben ha et flagg `skip_nordnet` som hopper over henting og bruker databasen i repoet. Dokumenter dette i README.
* Personvern: Repoet og siden kan være offentlige. Ingen beholdninger, beløp eller personlige data skal noen gang committes. Bare modell, univers og anbefalte vekter.

## 8. README og dokumentasjon

README på norsk med: hva prosjektet gjør, arkitektur (diagram), hvordan kjøre lokalt (`pip install -r requirements.txt`, kommandoene i rekkefølge, `--max-pages 1` for rask test), alle parametere i `config.yaml` forklart, Actions-oppsettet, fallback for lokal Nordnet-henting, kjente begrensninger (yfinance uoffisiell, ticker-dekning, survivorship bias fordi bare dagens ETF-er er med, estimeringsfeil) og forbehold om at det ikke er finansiell rådgivning.

## 9. Faser (lever og test hver fase før neste)

1. Repo + Nordnet-henting + database + diff. Tester mot fixture-HTML. Kjør `--max-pages 1`, så full kjøring lokalt. Rapporter: antall ETF-er, unike ISIN-er, hvilke ekstra felt som ble funnet.
2. Ticker-mapping + prishistorikk i NOK. Rapporter dekningsgrad.
3. Universreduksjon (dedup, TE-klynging, representantvalg) med klyngerapport og akseptansetestene i seksjon 4.
4. Optimering, frontier, bootstrap, walk-forward backtest og frekvenssammenligning. Eksporter JSON.
5. Nettside med alle seksjoner i seksjon 6. Lag gjerne først en versjon med eksempeldata slik at jeg kan vurdere oppsettet.
6. GitHub Actions + Pages + fallback. Kjør workflowen manuelt og bekreft at siden er publisert.
7. README og opprydding.

Etter hver fase: vis kort hva som er gjort, hva som ble testet og resultatet, og eventuelle valg jeg bør ta stilling til.

---

## Avklarte valg (fra oppfølgingen)

* Repo: Kvelliken/etf-portefolje, offentlig, GitHub Pages.
* Konto: ASK. ETF-er med EØS-domisil (fra ISIN-landkode) er ASK-tillatt.
* Ta med alle ETF-er i universet. Minst 5 års historikk kreves bare for å bli valgt som representant/optimeres. Kortere historikk vises fortsatt.
* Referanse: iShares MSCI ACWI (IE00B6R52259).
* Kurtasje: Nordnet Normal.
* Optimeringsbibliotek: PyPortfolioOpt (+ egen ERC/risk parity). Forventet avkastning: Black-Litterman-lignende prior (risikofri + beta mot referanse × risikopremie), historisk snitt krympet kraftig mot denne. Min.-vekt/maks antall løses iterativt.
* «Nåværende portefølje» beregnes i nettleseren fra localStorage; eksporter mu og kovarians for representantene til JSON.

## Status fase 1 (verifisert mot ekte data 2026-10-07, via GitHub Actions)

* Nordnet nås fra GitHubs servere (ingen blokkering). 2253 ETF-er, 2237 unike ISIN, alle i én runde.
* Stabil sortering: `sortField=name&sortOrder=asc` (ikke `sort_attribute`).
* Ekstra felt ligger under `fund_info.*` (avgift, kategori, utbytte, risiko, rating, fondsstørrelse, startdato). Det finnes ikke noe eget ASK-felt; ASK utledes fra ISIN-landkoden.
