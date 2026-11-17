# Oppdrag: Vargvind-design og enklere brukeropplevelse

> Skrevet 17. november 2026. Gjelder bare den statiske siden i `site/`. Datainnhenting, beregninger og
> GitHub Actions skal ikke endres.

## Mål

Siden fungerer og regner riktig, men den er lang, tett og lite intuitiv for en vanlig sparer, og den ser ikke
profesjonell ut. Målet er at en person uten økonomibakgrunn skal:

1. forstå på fem sekunder hva siden gjør og hva første steg er,
2. kunne sette sammen en portefølje uten å lese hjelpetekst,
3. få svar på de fem spørsmålene (hva eier jeg, billigere tvilling, kostnad, risiko, bedre fordeling) med ett
   tydelig hovedtall per spørsmål, og finne detaljene bare hvis hen vil,
4. stole på tallene fordi kilde, dato og metode alltid er ett klikk unna.

Alt skal følge Vargvind-designprofilen.

## Designprofilen

- **Regler:** `docs/vargvind.md` (les hele før du begynner). Den er en kortversjon av Vargvind-designsystemet,
  tilpasset denne siden.
- **Filer:** `site/vargvind/tokens.css` (alle farger, typografi, avstander), `site/vargvind/components.css`
  (klasser med prefikset `vv-`), `site/vargvind/logo/` og `site/vargvind/ikoner/` (16 linjeikoner).
- **Fonter:** Inter og Cormorant Garamond ligger selvhostet i `site/vargvind/fonts/` (latin-subsett fra
  `@fontsource`, dekker æ, ø, å og minustegn; SIL OFL, lisensfilene ligger ved siden av). Ikke bruk Google Fonts.
- Bruk tokennavnene (`var(--ink-900)`), aldri hex-verdier, både i CSS og når JS leser farger til Plotly.
- Bygg på `vv-`-klassene. Trengs noe nytt, lag det i samme stil (samme tokens, samme navngiving) i
  `site/style.css`, ikke i `components.css`, slik at Vargvind-filene kan oppdateres senere.

## Det som ikke fungerer i dag

Fra en gjennomgang av https://kvelliken.github.io/etf-portefolje/ (1040 px bredde, anbefalt portefølje valgt):

- **Alt ligger på én svært lang side.** Bygger, fem spørsmål, rundt 15 figurer og 8 tabeller etter hverandre.
  Hovedfunnene drukner i detaljer.
- **Seksjonene vises før brukeren har en portefølje.** Overskrifter og tomme figurer står under en tom bygger.
- **Horisontal rullefelt** på 1040 px; noe flyter over.
- **Toppfeltet er trangt:** datolinjen brytes over to linjer, «Mørk modus»-knappen brytes over to linjer.
- **Risikoprofil-velgeren** (5 valg) brytes til to rader, og forklaringen under er et langt avsnitt.
- **«Avkastning før kostnader»** står blant de vanlige feltene, men er et ekspertvalg som forvirrer.
- **Billigere tvilling** viser én full tabell per fond med tre alternativer hver, og samme forbehold om ETF-er
  gjentas under hver tabell.
- **Fargebruken er urolig og bryter profilen:** rødt og grønt for gode og dårlige år, rødt-til-grønt-bakgrunn
  i risiko/avkastning-kartet, rødt felt for kostnader og største fall, sterk oransje i rutekartet, åtte
  seriefarger (`--s1`…`--s8`, `--pf-*`).
- **Fagord uten forklaring der de står:** Sharpe, pp, volatilitet, R², TER.
- **Datoer og tall** står som «02.11.2026» og «+0,3 pp» i stedet for «2. november 2026» og «+0,3 p.p.»
- **Finn fond / Finn ETF-er** er tette Tabulator-tabeller med mange kolonner som standard.

## Ny struktur

Foreslå gjerne bedre løsninger, men dette er utgangspunktet.

### Felles for alle faner

- **Toppfelt (`vv-header`):** negativ logo til venstre, hovedmeny til høyre: *Min portefølje*, *Finn fond*,
  *Finn ETF-er*, *Data og metode*. Fanene beholdes som faner i samme side, men ser ut som meny, og fanevalget
  lagres i URL-en (`#portefolje`, `#fond`, `#etf`, `#metode`) slik at tilbake-knappen og lenker virker.
  Antall fond i porteføljen vises som `vv-badge` ved *Min portefølje*.
- **Sidetopp (`PageHeader`):** kort sidetittel i antikva-versaler (`vv-page-title`, f.eks. «PORTEFØLJE»),
  én ingress (`vv-lede`) og metadatalinjen (`vv-meta`): kurser til, nøkkeltall per, Nordnet hentet, neste
  oppdatering (første virkedag i neste måned). Datoer skrevet ut.
- **Bunnfelt (`vv-footer`):** kilder (Nordnet, Morningstar via Nordnet, Yahoo Finance, OpenFIGI, Norges Bank),
  metode, endringslogg (fra `changes.json`), forbehold («Modellverktøy, ikke finansiell rådgivning. Historisk
  avkastning er ingen garanti for fremtidig avkastning.») og personvern (alt lagres bare i nettleseren).
  **Ikke dikt opp** avsender, navn eller kontaktinformasjon; spør meg.
- **Favicon:** `vargvind-symbol.svg`.
- **Mørk modus fjernes.** Vargvind har bare lyst tema. Fjern knappen, de mørke tokenene og lesingen av
  `etfpf.theme` (en gammel lagret verdi skal ikke ødelegge noe).

### Min portefølje

1. **Bygg** (øverst, uendret rekkefølge, men enklere):
   - *Sparingen din:* tre felt (har i dag, per måned, antall år). «Avkastning før kostnader» flyttes inn i
     `vv-details` «Avanserte innstillinger».
   - *Anbefalt portefølje:* risikoprofilene som fem radioknapp-kort på én rad (stables på mobil), hvert med navn,
     aksjeandel og én kort setning. Den lange begrunnelsen kortes ned til én til to setninger. Fordelingsstripen
     og listen over fond beholdes. Én primærknapp: «Bruk denne porteføljen».
   - *Dette er i porteføljen:* tabellen i `vv-table`-stil. «historikk anslått» blir `vv-badge` med info-ikon og
     forklaring i verktøytips. Knappene «Fordel likt», «Juster til 100 %», «Kopier lenke», «Tøm» blir
     sekundær-/spøkelsesknapper; bare én primærhandling synlig om gangen.
   - *På ett blikk*-panelet blir en kolonne med `vv-kpi`-kort (forventet avkastning, verste år, kostnad,
     risikonivå). Vis spenn der motoren har det (f.eks. dårlig / mest sannsynlig / bra fra viften), og kall
     forventet avkastning et anslag.
2. **Tom tilstand:** så lenge porteføljen er tom, skjules de fem spørsmålene og erstattes av én rolig plassholder
   som forklarer hva brukeren får se.
3. **Sammendrag** (nytt, rett under byggeren når porteføljen har fond): fem kort på rad, ett per spørsmål, hvert
   med ett hovedtall, én setning og lenke til detaljene. Eksempel: «19 % i de samme 10 selskapene»,
   «21 000 kr å spare på billigere tvillinger», «Kostnadene tar 37 000 kr over 20 år», «Verste år: −26 %»,
   «Samme risiko, +0,4 p.p. forventet avkastning». Dette er femsekunderstesten.
4. **De fem spørsmålene:** hver seksjon får samme oppbygning:
   seksjonstittel → `vv-callout--insight` med hovedfunnet i én setning → én hovedfigur i `vv-figure` →
   resten (flere figurer, tabeller, forklaringer) bak `vv-details` eller en `vv-toggle`. Mål: hver seksjon
   tar høyst rundt halvannen skjermhøyde på desktop før brukeren selv åpner noe.
   - *Billigere tvilling:* én samlet tabell med én rad per fond (beste tvilling, kostnad før/etter, kroner
     spart, likhet, «Bytt»). «Vis flere alternativer» per rad. ETF-forbeholdet står én gang.
   - *Kostnad:* hovedtallet i kroner, figuren med gapet, tabellen per fond bak «Vis per fond».
   - *Risiko:* verdiutviklingen med største fall markert som hovedfigur; år for år, hvem som står for
     svingningene og viften bak faner eller `vv-details`.
   - *Bedre fordeling:* glideren og forslaget først, kartet under.
5. **«Slik er tallene regnet»** flyttes til *Data og metode*, med lenke fra hver seksjon.

### Finn fond og Finn ETF-er

- Filterlinje øverst i ett tydelig felt (søk, type, region, maks kostnad osv.) med «Nullstill».
- Standardvisning med få kolonner (navn, type, kostnad, avkastning 5 år, svingninger, legg til).
  `vv-toggle` «Enkel / Alle nøkkeltall» viser resten.
- Tabulator restyles til `vv-table`-utseendet: hvit flate, tabellhode i `bg-200`, 12 px halvfet `ink-700`,
  hårlinjer i `line-200`, radhøyde minst 44 px, tabelltall, høyrejusterte tall.
- «Legg til»-knappen er tydelig og gir synlig kvittering («Lagt til i porteføljen»).
- Risiko/avkastning-grafen følger figurreglene under.

### Data og metode

Ny egen fane som samler: «Slik er tallene regnet», «Slik bruker du nøkkeltallene» (som ordliste med ankre, slik
at fagord andre steder kan lenke hit), datakilder og dekning, kjente begrensninger (fra README), endringslogg og
forbehold.

## Figurer

Alle grafer lages i dag med Plotly via hjelpefunksjonene `css()`, `axis()`, `layout()` og `plot()` øverst i
`site/app.js`. Start der, så slår det gjennom overalt:

- Inter i all figurtekst, aksetekst 12 px `ink-500`, rutenett `line-200` (bare vannrett), akselinje `line-400`,
  hvit bakgrunn, verktøytips hvitt med `line-200`-kant og norsk tallformat.
- Hver figur pakkes i `vv-figure` med budskapstittel, undertittel (mål, enhet, periode), figur, kort tolkning
  (`__takeaway`), kilde og bunnlinje med «Om dataene», «Vis som tabell» og «Last ned CSV».
- `role="img"` og `aria-label` som gjengir funnet, ikke bare figurtypen.

Konkret omlegging av fargene (erstatt `--s1`…`--s8`, `--pf-*`, `--good`, `--bad`, `--mine`, `--ref` og
`sharpeBackdrop`):

| Figur | I dag | Ny |
| --- | --- | --- |
| Risiko/avkastning-kart | rød-til-grønn bakgrunn | Ingen fargebakgrunn, eller svært lys sekvensiell blå. Isolinjene for Sharpe 0 / 0,5 / 1 beholdes med direkte etiketter i klartekst. Fond `chart-context`, porteføljen din `chart-focus`, forslaget `chart-2`, fronten `chart-reference`. |
| År for år | grønne og røde søyler | `div-pos-2` over null, `div-neg-2` under null, med verdien skrevet på søylen. |
| Kostnadsgap over tid | rødt felt | Gapet i `chart-context` (eller `band-focus`) med direkte etikett «Kostnader: 37 000 kr». Linjene merket direkte. |
| Største fall | rødt felt | Perioden skyggelagt med `band-focus` og annotert. |
| Vifte | blått bånd | `chart-focus` for mest sannsynlig, `band-focus` for det midterste spennet, `band-context` for det ytre. Forklar spennet i undertittelen. |
| Rutekart | mange farger, sterk oransje | Maks fire farger fra tokens, f.eks. sekvensiell blå for aksjene og `chart-2` for renter. Etiketter lesbare (hvit tekst fra `seq-3`). |
| Fordelingsstriper | én farge per fond | `chart-1`…`chart-4`; flere enn fire fond slås sammen til «Øvrige» i striper, mens tabellen viser alle. |
| Land, bransjer, selskaper | | Én farge (`chart-focus`), sortert synkende, verdien ved enden av søylen. |
| Hvem står for svingningene | | Grupperte søyler: andel av pengene `chart-context`, andel av risikoen `chart-focus`. |

Grønt og rødt (`positive-*`, `negative-*`) brukes bare for status og advarsler, alltid med tekst eller ikon.

## Rammer

- **Ikke endre beregninger.** `engine.js` og `insight.js` røres ikke, bortsett fra rene visningshjelpere hvis
  det er helt nødvendig. Tallene på siden skal være de samme før og etter.
- **Ikke endre** datapipelinen, `site/data/`, GitHub Actions, localStorage-nøklene (unntatt temaet) eller
  formatet på «Kopier lenke»; gamle delte lenker skal fortsatt virke.
- Ingen nye rammeverk eller byggesteg. Fortsatt ren HTML/CSS/JS med Plotly og Tabulator fra CDN, og
  `?v=__V__`-cachebustingen på alle CSS- og JS-filer (også de nye).
- All tekst på bokmål, i klarspråk, uten utropstegn. Kode og kommentarer kan være på engelsk.
- Siden skal fungere fra 360 px til bred skjerm, uten horisontal rulling, og kunne brukes med tastatur alene.

## Arbeidsmåte

1. Les `docs/vargvind.md`, dette dokumentet, `README.md` og koden i `site/`. Start siden lokalt
   (`make serve`) og ta skjermbilder av dagens side (1280 px og 390 px, tom og med anbefalt portefølje) med
   Playwright. Lagre dem utenfor repoet.
2. **Vis meg en plan før du skriver mye kode:** ny sidestruktur, hvilke komponenter som brukes hvor, hva som
   flyttes bak «Vis mer», og hva du er usikker på. Spør hvis noe er uklart eller motstridende.
3. Arbeid på en egen gren, `claude/vargvind-design`, i små commits per fase:
   1. Grunnmur: fonter, tokens og components.css lenket inn, toppfelt, bunnfelt, mørk modus fjernet.
   2. Plotly- og Tabulator-tema via de felles hjelperne.
   3. Min portefølje: bygger, tom tilstand, sammendrag, de fem seksjonene.
   4. Finn fond og Finn ETF-er.
   5. Data og metode, ordliste, tekst- og tallformat.
4. Etter hver fase: skjermbilder i de samme fire tilstandene, se på dem selv, og rett det som ikke følger
   profilen. Kjør `make test`.
5. Til slutt: gå gjennom sjekklisten i `docs/vargvind.md`, kontroller kontrast og tastaturnavigasjon, oppdater
   README (avsnittet «Slik brukes siden») og åpne en PR med før/etter-skjermbilder og en kort liste over hva som
   er endret og hva som gjenstår.

## Ferdig når

- [ ] Siden bruker bare Vargvind-tokens; ingen hex-verdier eller gamle fargevariabler igjen i `style.css` eller JS
- [ ] Toppfelt med negativ logo og meny, sidetopp med metadatalinje og bunnfelt med kilder og forbehold på alle faner
- [ ] En ny bruker ser hva første steg er uten å rulle (1280 px)
- [ ] Sammendraget gir ett hovedtall per spørsmål; detaljer ligger bak «Vis mer»
- [ ] Ingen tomme seksjoner når porteføljen er tom
- [ ] Alle figurer i figurkort med budskapstittel, kilde, tabellvisning og CSV; ingen rød/grønn koding av gevinst/tap
- [ ] Datoer skrevet ut, `p.p.`, ekte minustegn, mellomrom før `%` og `kr`
- [ ] Ingen horisontal rulling fra 360 px; alt kan brukes med tastatur; fokus synlig
- [ ] Samme tall som før på samme portefølje; gamle delte lenker virker; `make test` er grønn
