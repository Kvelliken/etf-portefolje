# Vargvind – designprofil for porteføljesiden

Kortversjon av Vargvind-designsystemet (versjon 2, november 2026), tilpasset denne siden. Filene ligger i
`site/vargvind/`: `tokens.css` (farger, typografi, avstand), `components.css` (klasser med prefikset `vv-`),
`logo/` og `ikoner/`. Bruk tokennavnene, aldri hex-verdier direkte i CSS eller JS.

## Prinsipper

1. **Rolig og profesjonelt.** Mye luft, én nøytral grunnfarge (marineblå på lys gråblå), ingen pynt.
2. **Hvert tall kan etterprøves.** Kilde, dato og metode er ett klikk unna. Figurkortet samler dem.
3. **Vis usikkerhet.** Spenn og intervaller rundt estimater (forventet avkastning, fremtidig verdi).
4. **Funnet først.** Hver figur svarer på ett spørsmål. Budskapet skal sitte på fem sekunder; detaljene belønner den som vil grave.
5. **Vis hvem som står bak.** Avsender, kilder, endringslogg og forbehold er synlige på alle sider.
6. **Lesbart for alle.** WCAG 2.1 A og AA, designet mot 2.2. Farge bærer aldri betydning alene. Alle figurer finnes også som tabell.

## Logo

- `vargvind-logo-negativ.svg` i det mørke toppfeltet og bunnfeltet (`surface-dark`). Minst 160 px bred.
- `vargvind-symbol.svg` som favicon. Minst 24 px.
- Logoen står bare på `bg-100`, `bg-000` eller `surface-dark`. Ikke endre farger eller proporsjoner, og ikke sett navnetrekket i tekst.
- Frisone: minst ¼ av symbolets høyde rundt logoen.

## Farger

| Rolle | Token | Bruk |
| --- | --- | --- |
| Marineblå | `brand-900` / `ink-900` | Overskrifter, tall, primærknapp, toppfelt, fremhevet dataserie |
| Skifergråblå | `brand-600` | Lenker, ikoner, fokusring |
| Lys gråblå | `brand-300` | Tekst på mørk flate, kontekstserier i figurer. Aldri tekst på lys bakgrunn |
| Lys blå | `brand-100` | Hovedfunnbokser, markert tekst, fremhevet tabellrad |
| Sidebakgrunn | `bg-100` | Hele siden |
| Hvit | `bg-000` | Kort, figurer, tabeller |
| Lys grå | `bg-200` | Tabellhode, nøytrale merkelapper, merknader |

- Tekst: `ink-900` for overskrifter og tall, `ink-700` for avsnitt og tabelltekst, `ink-500` for metadata, kilder og aksetekst. Ingen tekst lysere enn `ink-500`.
- Ingen varm aksentfarge. Fremheving gjøres med marineblå mot gråblått.
- `positive-*` og `negative-*` er bare for status mot mål, advarsler og feil, alltid sammen med tekst eller ikon. **Ikke** for gevinst/tap eller høy/lav kostnad.
- Bare lyst tema. Vargvind har ingen mørk modus.
- Kontrast: tekst minst 4,5:1, grafiske elementer og kontrollkanter minst 3:1.

## Typografi

- **Cormorant Garamond** (`--font-display`): bare sidetitler (`vv-page-title`) og sparsomt seksjonstitler (`vv-section-title`), i versaler med 0,3 em sperring. Korte navn, aldri setninger eller tall.
- **Inter** (`--font-sans`): alt annet, også all tekst i figurer. Tall med `font-variant-numeric: tabular-nums`.
- Budskapstitler er setninger i Inter: `heading-xl` (32 px) for sidens hovedbudskap, `heading-lg` (22 px) på figurkort.
- Brødtekst 16 px, maks lesebredde `measure` (68 tegn). Minste størrelse 12 px.

## Språk og tall

- Klarspråk, ingen hype, ingen utropstegn. Navigasjon bruker brukernes egne ord.
- Mellomrom som tusenskille og før `%` og enheter: `52 000 kr`, `4,2 %`. Desimalkomma.
- Endring med fortegn og ekte minustegn: `+4,0 %`, `−1,2 %`. Prosentpoeng skrives `p.p.`
- Datoer skrives ut: «2. november 2026», ikke «02.11.2026».
- Fagord (Sharpe, volatilitet, beta, TER) forklares i klartekst der de står, eller i en ordliste.

## Layout

- Maks innholdsbredde `content-max` (1200 px). Figurer bruker full bredde; brødtekst holder seg innenfor `measure`.
- `space-12` (48 px) mellom seksjoner. Kort har `space-6` polstring, `radius-lg` og hårlinje `line-200`, ikke skygge.
- `shadow-md` bare for menyer og verktøytips som flyter over innholdet.
- Klikkbare flater minst 44 px høye. Fokus vises med 2 px `focus-ring`.
- Ingen horisontal rulling på noen skjermbredde ned til 360 px.

## Komponenter (`components.css`)

| Komponent | Klasse | Bruk her |
| --- | --- | --- |
| SiteHeader | `vv-header`, `vv-nav` | Mørkt toppfelt med negativ logo og hovedmeny |
| PageHeader | `vv-page-title`, `vv-lede`, `vv-meta` | Sidetittel, ingress, metadatalinje (datagrunnlag, kilder, sist oppdatert, neste oppdatering) |
| FigureCard | `vv-figure` + `__title`, `__subtitle`, `__body`, `__takeaway`, `__source`, `__footer` | Alle grafer: budskapstittel, undertittel, figur, tolkning, kilde, «Om dataene», tabellvisning, CSV |
| KeyFigure | `vv-kpi` + `__label`, `__value`, `__unit`, `__range`, `__meta` | Nøkkeltall med spenn og referanse |
| Table | `vv-table`, `vv-table-wrap`, `vv-num`, `vv-table__highlight` | Alle tabeller, også Tabulator-tabellene |
| Callout | `vv-callout--insight`, `vv-mark` | Hovedfunn og merknader |
| Badge | `vv-badge`, `--info`, `--positive`, `--negative` | «historikk anslått», «ETF», «Nesten identisk» |
| Button | `vv-btn--primary`, `--secondary`, `--ghost` | Én primærhandling per område |
| Toggle | `vv-toggle` | Figur/tabell, valg mellom få alternativer |
| Details | `vv-details` | «Om dataene», «Slik er tallene regnet», avanserte innstillinger |
| TrustFooter | `vv-footer` | Bunnfelt med avsender, kilder, metode, endringslogg, forbehold |

## Figurer

- **Én melding per figur.** Budskapstittel når figuren viser en retning («Kostnadene tar 37 000 kr over 20 år»), beskrivende tittel for oppslag.
- **Undertittel** sier mål, enhet, periode og utvalg.
- **Fokuspalett først:** porteføljen til brukeren i `chart-focus`, alt annet i `chart-context`, referanser (indeks, gjennomsnitt) i `chart-reference` med direkte etikett.
- **Kategoripalett** `chart-1` … `chart-4` i fast rekkefølge, maks fire kategorier. Flere grupperes («Øvrige») eller vises som rangert søylediagram i én farge.
- **Sekvensiell** `seq-1` … `seq-5` for mengde (lys = lite, mørk = mye). **Divergerende** `div-neg-*` / `div-mid` / `div-pos-*` for verdier over og under et nullpunkt.
- Søyler starter på null. Én y-akse. Rette linjestykker, ingen kurveglatting. Stiplet linje bare for prognoser og ufullstendige data.
- Usikkerhetsbånd i `band-focus` / `band-context`, forklart i undertittelen.
- Merk serier direkte i stedet for tegnforklaring der det går. Rutenett lyst (`line-200`) og vannrett.
- Figurer står alltid på hvitt (`bg-000`).
- Hver figur har `role="img"` med `aria-label` som gjengir funnet, og samme data som tabell og CSV.
- Hold standardvisningen ren; detaljer bak verktøytips og utvidbare felt.

## Sjekkliste før publisering

- [ ] Budskapstittel og undertittel på hver figur
- [ ] Enhet, periode og utvalg oppgitt; usikkerhet vist der den finnes
- [ ] Kilde og «Om dataene» på hver figur; data som tabell og CSV
- [ ] Farger fra tokens; farge er aldri eneste bærer av betydning
- [ ] Tall og datoer i norsk format; ingen skrivefeil eller døde lenker
- [ ] Tastaturnavigasjon og synlig fokus; ingen horisontal rulling ned til 360 px
- [ ] «Sist oppdatert» og endringslogg er oppdatert
