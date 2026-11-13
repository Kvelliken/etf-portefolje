/* Fond-fanen: alle verdipapirfond i Nordnets fondsliste, kostnad hos Nordnet, avkastning og risikotall i NOK,
 * sammenlignet med ETF-er i samme Morningstar-kategori (avkastning til samme dato, se funddata.py).
 * Risikotallene (volatilitet, Sharpe, alfa, beta, R²) hentes per fond fra Nordnet, se funddetails.py.
 * Bruker hjelpefunksjonene og ETF-dataene (D) fra app.js. Hovedfanene (ETF/Fond) styres herfra. */
"use strict";

const FPERIODS = [1, 3, 5, 10];
const FLS = { tab: "etfpf.tab", filters: "etfpf.fond.filters.v1" };
const FDD = [["asset_class", "Aktivaklasse"], ["sector", "Sektor"], ["region", "Region"], ["theme", "Tema"],
  ["style", "Stil"], ["company", "Forvalter"]];
const FS = { f: null, period: 5, xaxis: "vol", table: null, data: null, loading: null, list: [] };
// Nordnet har risikotall for 1, 3 og 5 år. For 10 år brukes 5 år.
const riskP = (P) => (P >= 5 ? 5 : P);
const rk = (k, P) => `${k}${riskP(P)}`;

// ---------------------------------------------------------------- main tabs
function showTab(tab, { scroll = false } = {}) {
  for (const t of ["etf", "fond"]) {
    $(`tab-${t}`).hidden = t !== tab;
    $(`tabbtn-${t}`).setAttribute("aria-selected", t === tab ? "true" : "false");
    document.querySelector(`.nav[data-for="${t}"]`).hidden = t !== tab;
  }
  store.set(FLS.tab, tab);
  if (tab === "fond") ensureFond();
  // Charts and tables drawn while hidden have no width: let them measure again.
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event("resize"));
    if (tab === "etf" && typeof st !== "undefined" && st.table) st.table.redraw(true);
    if (tab === "fond" && FS.table) FS.table.redraw(true);
  });
  if (scroll) window.scrollTo({ top: 0 });
}

function tabFromHash() {
  const h = location.hash;
  if (h.startsWith("#fond")) return "fond";
  if (h && document.querySelector(`#tab-etf ${CSS.escape(h)}`)) return "etf";
  return null;
}

function setupTabs() {
  document.querySelector(".main-tabs").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-tab]"); if (!b) return;
    showTab(b.dataset.tab, { scroll: true });
  });
  window.addEventListener("hashchange", () => { const t = tabFromHash(); if (t) showTab(t); });
  showTab(tabFromHash() || store.get(FLS.tab, "etf"));
}

// ---------------------------------------------------------------- data
function waitForEtfs(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (D.list && D.summary) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error("ETF-dataene ble ikke lastet"));
      setTimeout(poll, 100);
    })();
  });
}

function median(a) {
  const v = a.filter(ok).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function ensureFond() {
  if (FS.loading) return FS.loading;
  FS.loading = Promise.all([
    fetch("data/funds.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(`funds.json: HTTP ${r.status}`); return r.json(); }),
    waitForEtfs(),
  ]).then(([data]) => {
    FS.data = data;
    prepareFunds();
    FS.f = Object.assign(defaultFundFilters(), store.get(FLS.filters, {}));
    FS.period = FS.f.period || 5;
    FS.xaxis = FS.f.xaxis === "cost" ? "cost" : "vol";
    setupFundFilters();
    setupFundTable();
    renderFundMethod();
    refreshFunds();
    redraw.push(renderFundChart);
  }).catch((e) => {
    notice($("fond-status"), "critical", `<strong>⚠ Feil:</strong> Kunne ikke laste fonddata (${esc(e.message)}).`);
    console.error(e);
  });
  return FS.loading;
}

function prepareFunds() {
  const R = FS.data.etf_returns || {};
  const byCat = {};
  for (const e of D.list) {
    e.fr = R[e.isin] || null;
    if (!e.fr || !e.pick || !e.ask || e.leveraged || e.asset_class === "Giret/invers") continue;
    (byCat[e.category] ||= []).push(e);
  }
  for (const list of Object.values(byCat)) list.sort((a, b) => (a.fee ?? 9) - (b.fee ?? 9) || (b.fund_size || 0) - (a.fund_size || 0));
  const asOf = new Date(FS.data.as_of);
  FS.list = FS.data.funds;
  for (const f of FS.list) {
    f.alts = byCat[f.category] || [];
    f.cheapest = f.alts.find((e) => ok(e.fee)) || null;
    f.etf_med = {};
    FPERIODS.forEach((P, k) => { f.etf_med[P] = median(f.alts.map((e) => e.fr[k])); });
    f.years = f.start ? (asOf - new Date(f.start)) / (365.25 * 864e5) : null;
    f.size_m = ok(f.fund_size) ? f.fund_size / 1e6 : null;
  }
}

// ---------------------------------------------------------------- filters
function defaultFundFilters() {
  return { q: "", dd: Object.fromEntries(FDD.map(([k]) => [k, []])), kind: "all", cost: "", hist: 0, sfdr: "all", acc: "all",
    ask: true, selection: false, unhedged: false, period: 5, xaxis: "vol" };
}
function saveFundFilters() { store.set(FLS.filters, { ...FS.f, period: FS.period, xaxis: FS.xaxis }); }
const onFundFilter = debounce(() => { saveFundFilters(); refreshFunds(); }, 60);

function setupFundFilters() {
  const F = FS.f;
  const row = $("ff-dd-row");
  row.innerHTML = FDD.map(([k, label]) => `<details class="dd" data-k="${k}"><summary><span class="dd-label">${esc(label)}:</span><span class="dd-val">alle</span></summary><div class="dd-panel"></div></details>`).join("");
  row.querySelectorAll(".dd").forEach((dd) => {
    const k = dd.dataset.k, counts = {};
    for (const f of FS.list) { const v = f[k] ?? NONE; counts[v] = (counts[v] || 0) + 1; }
    const opts = Object.entries(counts).sort((a, b) => (a[0] === NONE) - (b[0] === NONE) || b[1] - a[1] || a[0].localeCompare(b[0], "nb"));
    dd.querySelector(".dd-panel").innerHTML = `<div class="dd-actions"><button type="button" data-a="all">Vis alle (fjern valg)</button></div>` +
      opts.map(([v, n]) => `<label><input type="checkbox" value="${esc(v)}" ${F.dd[k]?.includes(v) ? "checked" : ""}> ${esc(v)} <span class="n">${num(n)}</span></label>`).join("");
    dd.addEventListener("toggle", () => { if (dd.open) row.querySelectorAll(".dd[open]").forEach((o) => { if (o !== dd) o.open = false; }); });
    dd.querySelector(".dd-panel").addEventListener("change", () => {
      F.dd[k] = [...dd.querySelectorAll("input:checked")].map((i) => i.value); syncFundDD(); onFundFilter();
    });
    dd.querySelector(".dd-actions").addEventListener("click", (ev) => {
      if (!ev.target.dataset.a) return;
      dd.querySelectorAll("input").forEach((i) => { i.checked = false; });
      F.dd[k] = []; syncFundDD(); onFundFilter();
    });
  });
  document.addEventListener("click", (ev) => { if (!ev.target.closest("#ff-dd-row .dd")) row.querySelectorAll(".dd[open]").forEach((o) => { o.open = false; }); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") row.querySelectorAll(".dd[open]").forEach((o) => { o.open = false; }); });

  const bind = (id, key, kind = "value", ev = "change") => {
    const el = $(id);
    if (kind === "checked") el.checked = !!F[key]; else el.value = F[key];
    el.addEventListener(ev, () => { F[key] = kind === "checked" ? el.checked : el.value; onFundFilter(); });
  };
  const s = $("ff-search"); s.value = F.q; s.addEventListener("input", debounce(() => { F.q = s.value; onFundFilter(); }, 150));
  bind("ff-kind", "kind"); bind("ff-cost", "cost", "value", "input"); bind("ff-hist", "hist"); bind("ff-sfdr", "sfdr"); bind("ff-acc", "acc");
  bind("ff-ask", "ask", "checked"); bind("ff-selection", "selection", "checked"); bind("ff-hedged", "unhedged", "checked");
  $("ff-reset").addEventListener("click", () => { store.set(FLS.filters, defaultFundFilters()); location.reload(); });
  const pe = $("ff-period");
  pe.innerHTML = FPERIODS.map((P) => `<button type="button" role="tab" data-p="${P}" aria-selected="${P === FS.period}">${P} år</button>`).join("");
  pe.onclick = (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    FS.period = +b.dataset.p;
    pe.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", x === b ? "true" : "false"));
    FS.table && FS.table.setColumns(fundColumns());
    onFundFilter();
  };
  const xa = $("ff-xaxis");
  xa.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", x.dataset.x === FS.xaxis ? "true" : "false"));
  xa.onclick = (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    FS.xaxis = b.dataset.x;
    xa.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", x === b ? "true" : "false"));
    saveFundFilters(); renderFundChart();
  };
  syncFundDD();
}
function syncFundDD() {
  document.querySelectorAll("#ff-dd-row .dd").forEach((dd) => {
    const v = FS.f.dd[dd.dataset.k] || [];
    dd.querySelector(".dd-val").textContent = !v.length ? "alle" : v.length === 1 ? v[0] : `${v.length} valgt`;
    dd.classList.toggle("active", v.length > 0);
  });
}

function fundPasses(f, F) {
  if (F.ask && !f.ask) return false;
  if (F.selection && !f.nordnet_selection) return false;
  if (F.unhedged && f.hedged) return false;
  if (F.kind === "index" && !f.index) return false;
  if (F.kind === "active" && f.index) return false;
  for (const [k] of FDD) { const sel = F.dd[k]; if (sel && sel.length && !sel.includes(f[k] ?? NONE)) return false; }
  if (F.cost !== "" && ok(+F.cost) && !(f.cost <= +F.cost)) return false;
  if (+F.hist > 0 && !(f.years >= +F.hist)) return false;
  if (F.sfdr === "8" && !(f.sfdr >= 8)) return false;
  if (F.sfdr === "9" && f.sfdr !== 9) return false;
  if (F.acc === "acc" && f.acc !== true) return false;
  if (F.acc === "dist" && f.acc !== false) return false;
  if (F.q) {
    const q = F.q.trim().toLowerCase();
    if (q && ![f.name, f.company, f.isin, f.ticker].some((v) => String(v || "").toLowerCase().includes(q))) return false;
  }
  return true;
}

// ---------------------------------------------------------------- KPIs, chart
const rKey = (P) => `r${P}`;
const diffVsEtf = (f, P) => (ok(f[rKey(P)]) && ok(f.etf_med[P]) ? f[rKey(P)] - f.etf_med[P] : null);

function renderFundKpis(list) {
  const P = FS.period;
  const act = list.filter((f) => !f.index), idx = list.filter((f) => f.index);
  const cmp = act.filter((f) => ok(diffVsEtf(f, P)));
  const beat = cmp.filter((f) => diffVsEtf(f, P) > 0).length;
  const extra = median(act.map((f) => (f.cheapest && ok(f.cost) ? f.cost - f.cheapest.fee : null)));
  $("fond-kpis").innerHTML = [
    kpi("Fond i utvalget", num(list.length), `av ${num(FS.list.length)} hos Nordnet`),
    kpi("Median kostnad, aktive", ok(median(act.map((f) => f.cost))) ? nf(2).format(median(act.map((f) => f.cost))) + " %" : "–",
      `${num(act.length)} aktive fond`),
    kpi("Median kostnad, indeksfond", ok(median(idx.map((f) => f.cost))) ? nf(2).format(median(idx.map((f) => f.cost))) + " %" : "–",
      `${num(idx.length)} indeksfond`),
    kpi(`Aktive fond som slo ETF-ene, ${P} år`, cmp.length ? pct(beat / cmp.length, 0) : "–",
      `${num(beat)} av ${num(cmp.length)} over medianen for ETF-er i samme kategori`),
    kpi("Merkostnad mot billigste ETF", ok(extra) ? nf(2).format(extra) + " pp/år" : "–", "median for aktive fond, samme kategori"),
  ].join("");
}

function renderFundChart() {
  if (!FS.filtered) return;
  const P = FS.period, k = rKey(P), RP = riskP(P), vk = rk("vol", P), byVol = FS.xaxis === "vol";
  const xOf = (f) => (byVol ? (ok(f[vk]) ? f[vk] * 100 : null) : f.cost);
  const pts = FS.filtered.filter((f) => ok(xOf(f)) && ok(f[k]));
  const noRisk = byVol ? FS.filtered.filter((f) => ok(f[k]) && !ok(f[vk])).length : 0;
  $("fond-chart-note").textContent = `Annualisert avkastning ${P} år i NOK etter fondets kostnader, per ${dateNo(FS.data.as_of)}. ` +
    (byVol ? `Volatilitet = årlig standardavvik ${RP} år i NOK${RP !== P ? " (Nordnet har ikke 10 år)" : ""}. ` : "") +
    `${num(pts.length)} fond${noRisk ? ` (${num(noRisk)} mangler volatilitet)` : ""}.`;
  if (!pts.length) { emptyChart("chart-fond", "Ingen fond med tall for perioden – løsne på filtrene"); return; }
  const groups = [["Aktive fond", (f) => !f.index, "--pf-max_sharpe", "circle"], ["Indeksfond", (f) => f.index, "--pf-min_variance", "diamond"]];
  const traces = groups.map(([name, fn, col, sym]) => {
    const g = pts.filter(fn);
    return {
      type: "scatter", mode: "markers", name, x: g.map(xOf), y: g.map((f) => f[k] * 100),
      marker: { size: 9, color: css(col), symbol: sym, opacity: 0.85, line: { color: css("--surface"), width: 1 } },
      customdata: g.map((f) => [f.name, f.company || "", ok(f.etf_med[P]) ? pct(f.etf_med[P]) : "–", ok(diffVsEtf(f, P)) ? pp(diffVsEtf(f, P)) : "–",
        pctPP(f.cost), pct(f[vk]), num(f[rk("sharpe", P)], 2), pct(f[rk("alpha", P)]), num(f[rk("beta", P)], 2),
        ok(f[rk("r2", P)]) ? num(f[rk("r2", P)] * 100, 0) : "–"]),
      hovertemplate: "<b>%{customdata[0]}</b><br>%{customdata[1]}<br>Avkastning %{y:.1f} % per år · kostnad %{customdata[4]}" +
        `<br>${RP} år: vol. %{customdata[5]} · Sharpe %{customdata[6]}<br>Alfa %{customdata[7]} · beta %{customdata[8]} · R² %{customdata[9]}` +
        "<br>ETF-median i kategorien %{customdata[2]} (fond − ETF %{customdata[3]})<extra></extra>",
    };
  }).filter((t) => t.x.length);
  plot("chart-fond", traces, layout({
    xaxis: byVol ? axis({ titleText: `Volatilitet ${RP} år (NOK, % per år)`, ticksuffix: " %", rangemode: "tozero" })
      : axis({ titleText: "Kostnad hos Nordnet (% per år)", ticksuffix: " %", rangemode: "tozero" }),
    yaxis: axis({ titleText: `Annualisert avkastning ${P} år (NOK)`, ticksuffix: " %" }),
    hovermode: "closest", margin: { l: 64, r: 16, t: 32, b: 52 },
  }));
}

// ---------------------------------------------------------------- table
const pctPP = (v) => (ok(v) ? nf(2).format(v) + " %" : "–");
const stars = (r) => (ok(r) && r > 0 ? `<span class="stars" title="Morningstar-rating ${r} av 5">${"★".repeat(r)}${"☆".repeat(5 - r)}</span>` : "–");

function fundColumns() {
  const sorterNull = (a, b, aRow, bRow, col, dir) => {
    const na = !ok(a), nb = !ok(b);
    if (na && nb) return 0;
    if (na) return dir === "asc" ? 1 : -1;
    if (nb) return dir === "asc" ? -1 : 1;
    return a - b;
  };
  const retCol = (title, field, tip) => ({ title, field, hozAlign: "right", cssClass: "num", sorter: sorterNull, headerTooltip: tip,
    formatter: (c) => { const v = c.getValue(); return ok(v) && v < 0 ? `<span class="neg">${pct(v)}</span>` : pct(v); } });
  const costCol = (title, field, tip) => ({ title, field, hozAlign: "right", cssClass: "num", sorter: sorterNull, headerTooltip: tip,
    formatter: (c) => pctPP(c.getValue()) });
  const txt = (title, field, width) => ({ title, field, width, formatter: (c) => esc(c.getValue() ?? "–"), tooltip: true });
  const P = FS.period, RP = riskP(P);
  const numCol = (title, field, d, tip, mult = 1) => ({ title, field, hozAlign: "right", cssClass: "num", sorter: sorterNull, headerTooltip: tip,
    formatter: (c) => { const v = c.getValue(); return ok(v) ? (v < 0 ? `<span class="neg">${num(v * mult, d)}</span>` : num(v * mult, d)) : "–"; } });
  return [
    { title: "Fond", field: "name", frozen: true, width: 260, tooltip: true,
      formatter: (c) => { const d = c.getRow().getData(); return d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a>` : esc(d.name); } },
    txt("Forvalter", "company", 130),
    { title: "Type", field: "kind", width: 90 },
    txt("Sektor", "sector", 120), txt("Region", "region", 100),
    { title: "Kostnad hos Nordnet", columns: [
      costCol("Totalt", "cost", "Det du betaler per år: forvaltningshonorar − returprovisjon + plattformavgift (Nordnets tall)"),
      costCol("Forv.hon.", "fee", "Fondets årlige forvaltningshonorar"),
      costCol("Retur", "kickback", "Returprovisjon: del av honoraret Nordnet betaler tilbake til deg"),
      costCol("Plattform", "platform_fee", "Nordnets plattformavgift"),
    ] },
    { title: "Annualisert avkastning i NOK", columns: [
      retCol("1 år", "r1", "Annualisert avkastning i NOK etter fondets kostnader (Nordnets tall, utbytte medregnet)"),
      retCol("3 år", "r3", "Per år, ikke samlet. Nordnets fondsside viser samlet avkastning i fondets egen valuta"),
      retCol("5 år", "r5", "Per år, ikke samlet. Nordnets fondsside viser samlet avkastning i fondets egen valuta"),
      retCol("10 år", "r10", "Per år, ikke samlet. Nordnets fondsside viser samlet avkastning i fondets egen valuta")] },
    { title: `Risiko, ${RP} år (NOK)${RP !== P ? " – 10 år finnes ikke" : ""}`, columns: [
      retCol("Vol.", "vol", "Volatilitet: årlig standardavvik av avkastningen i NOK (Nordnet)"),
      numCol("Sharpe", "sharpe", 2, "Sharpe-rate: avkastning utover risikofri rente delt på volatiliteten, i NOK (Nordnet)"),
      retCol("Alfa", "alpha", "Alfa: årlig meravkastning utover det beta mot fondets referanseindeks tilsier, i NOK (Nordnet). Mangler for fond uten referanseindeks"),
      numCol("Beta", "beta", 2, "Beta: hvor mye fondet svinger med referanseindeksen (1 = like mye), i NOK (Nordnet)"),
      numCol("R²", "r2", 0, "R²: hvor stor del av svingningene referanseindeksen forklarer, 0–100. Morningstar, målt i SEK (som på Nordnets fondsside). Høy R² + lav alfa = indeksnært", 100),
    ] },
    { title: `Mot ETF-er i samme kategori, ${P} år`, columns: [
      retCol("ETF-median", "etf_med", "Median annualisert avkastning for ETF-er i samme Morningstar-kategori (én per indeks, ASK-tillatt), til samme dato"),
      { title: "Fond − ETF", field: "vs_etf", hozAlign: "right", cssClass: "num", sorter: sorterNull,
        headerTooltip: "Fondets avkastning minus ETF-medianen, prosentpoeng per år. Positivt = fondet slo ETF-ene",
        formatter: (c) => { const v = c.getValue(); return ok(v) ? `<span class="${v >= 0 ? "delta-pos" : "delta-neg"}">${pp(v)}</span>` : "–"; } },
      { title: "Billigste ETF", field: "cheapest_fee", hozAlign: "right", cssClass: "num", sorter: sorterNull,
        headerTooltip: "Lavest årlig kostnad (TER) blant ETF-ene i samme kategori. Klikk raden for å se dem",
        formatter: (c) => { const d = c.getRow().getData(); return ok(d.cheapest_fee) ? `${pctPP(d.cheapest_fee)} <span class="muted">${esc(d.cheapest_ticker)}</span>` : "–"; } },
      { title: "Antall", field: "n_alts", hozAlign: "right", cssClass: "num", headerTooltip: "ETF-er i samme kategori (klikk raden)" },
    ] },
    { title: "Risikoklasse", field: "risk", hozAlign: "right", cssClass: "num", sorter: sorterNull, headerTooltip: "Nordnets risikoklasse 1–7 (svingninger)" },
    { title: "Rating", field: "rating", sorter: sorterNull, formatter: (c) => stars(c.getValue()), headerTooltip: "Morningstar-rating" },
    { title: "SFDR", field: "sfdr", hozAlign: "right", sorter: sorterNull, formatter: (c) => (ok(c.getValue()) ? `Art. ${c.getValue()}` : "–"),
      headerTooltip: "Bærekraftsklassifisering: artikkel 6 (ingen), 8 (fremmer bærekraft) eller 9 (bærekraftig mål)" },
    { title: "Str. (mill.)", field: "size_m", hozAlign: "right", cssClass: "num", sorter: sorterNull, formatter: (c) => num(c.getValue(), 0),
      headerTooltip: "Fondets forvaltningskapital i millioner (fra Nordnet)" },
    { title: "Eiere", field: "owners", hozAlign: "right", cssClass: "num", sorter: sorterNull, formatter: (c) => num(c.getValue()),
      headerTooltip: "Antall eiere hos Nordnet" },
    { title: "Start", field: "start_year", hozAlign: "right", cssClass: "num", sorter: sorterNull },
    { title: "Utbytte", field: "acc", formatter: (c) => accLabel(c.getValue()) },
    txt("Valuta", "currency", 70),
    { title: "Min. innskudd", field: "min_investment", hozAlign: "right", cssClass: "num", sorter: sorterNull, formatter: (c) => kr(c.getValue()) },
    txt("Kategori", "category", 190),
  ];
}

function fundRow(f) {
  const P = FS.period;
  return {
    isin: f.isin, name: f.name, url: f.url, company: f.company, kind: f.index ? "Indeks" : (f.fund_type || "Aktiv"),
    sector: f.sector, region: f.region, cost: f.cost, fee: f.fee, kickback: f.kickback, platform_fee: f.platform_fee,
    r1: f.r1, r3: f.r3, r5: f.r5, r10: f.r10, etf_med: f.etf_med[P], vs_etf: diffVsEtf(f, P),
    vol: f[rk("vol", P)], sharpe: f[rk("sharpe", P)], alpha: f[rk("alpha", P)], beta: f[rk("beta", P)], r2: f[rk("r2", P)],
    cheapest_fee: f.cheapest?.fee ?? null, cheapest_ticker: f.cheapest?.ticker || "", n_alts: f.alts.length || null,
    risk: f.risk, rating: f.rating, sfdr: f.sfdr, size_m: f.size_m, owners: f.owners, start_year: f.start_year,
    acc: f.acc, currency: f.currency, min_investment: f.min_investment, category: f.category,
  };
}

function setupFundTable() {
  if (!window.Tabulator) { $("fund-explorer").innerHTML = '<p class="muted">Tabellbiblioteket kunne ikke lastes.</p>'; return; }
  FS.table = new Tabulator("#fund-explorer", {
    data: [], index: "isin", layout: "fitDataFill", maxHeight: "640px", placeholder: "Ingen treff – løsne på filtrene",
    columns: fundColumns(), initialSort: [{ column: "owners", dir: "desc" }], columnHeaderVertAlign: "bottom",
  });
  FS.ready = new Promise((res) => FS.table.on("tableBuilt", res));
  FS.table.on("rowClick", (e, row) => {
    if (e.target.closest("a,button")) return;
    const el = row.getElement();
    const open = el.querySelector(".alt-box");
    if (open) { open.remove(); row.normalizeHeight(); return; }
    const box = altBox(FS.list.find((f) => f.isin === row.getData().isin));
    // The row is as wide as all columns; keep the box within the visible part of the table.
    const holder = FS.table.element.querySelector(".tabulator-tableholder");
    box.style.width = `${Math.max(280, holder.clientWidth - 2)}px`;
    el.appendChild(box);
    row.normalizeHeight();
  });
}

function altBox(f) {
  const P = FS.period, k = FPERIODS.indexOf(P), RP = riskP(P);
  const box = document.createElement("div");
  box.className = "alt-box";
  if (!f.alts.length) {
    box.innerHTML = `<span class="muted">Ingen ETF-er hos Nordnet i samme kategori (${esc(f.category || "ukjent")}).</span>`;
    return box;
  }
  const mine = mineSet();
  const rows = f.alts.slice(0, 8).map((e) => {
    const d = ok(f[rKey(P)]) && ok(e.fr[k]) ? f[rKey(P)] - e.fr[k] : null;
    return `<tr><td><button type="button" class="add-btn ${mine.has(e.isin) ? "on" : ""}" data-isin="${e.isin}" aria-label="Legg i ETF-utvalget">${mine.has(e.isin) ? "✓" : "+"}</button></td>
      <td>${esc(e.ticker)}</td><td>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>` : esc(e.name)}</td>
      <td class="num">${pctPP(e.fee)}</td>${FPERIODS.map((_, j) => `<td class="num">${pct(e.fr[j])}</td>`).join("")}
      <td class="num">${pct(e.m?.[RP]?.vol)}</td><td class="num">${num(e.m?.[RP]?.sharpe, 2)}</td>
      <td class="num">${ok(d) ? `<span class="${d >= 0 ? "delta-pos" : "delta-neg"}">${pp(d)}</span>` : "–"}</td></tr>`;
  }).join("");
  box.innerHTML = `<strong>ETF-er i samme kategori</strong> <span class="muted">(${esc(f.category)}; ${num(f.alts.length)} ETF-er, én per indeks, sortert på kostnad.
      Samme kategori betyr lignende marked, ikke nødvendigvis samme indeks.)</span>
    <div class="table-scroll"><table class="data"><thead><tr><th></th><th>Ticker</th><th>Navn</th><th class="num">Kostnad</th>${FPERIODS.map((p) => `<th class="num">${p} år</th>`).join("")}<th class="num">Vol. ${RP} år</th><th class="num">Sharpe ${RP} år</th><th class="num">Fond − ETF, ${P} år</th></tr></thead><tbody>
      <tr class="total"><td></td><td>Fondet</td><td>${esc(f.name)}</td><td class="num">${pctPP(f.cost)}</td>${FPERIODS.map((p) => `<td class="num">${pct(f[rKey(p)])}</td>`).join("")}<td class="num">${pct(f[rk("vol", P)])}</td><td class="num">${num(f[rk("sharpe", P)], 2)}</td><td></td></tr>
      ${rows}</tbody></table></div>
    <p class="muted small-text">Trykk + for å legge en ETF i utvalget ditt under ETF-fanen. ETF-kostnaden er årlig TER; ved kjøp kommer kurtasje og spread i tillegg.
      Volatilitet og Sharpe for ETF-ene er regnet fra månedsavkastning i NOK til siste månedsslutt, for fondet er de Nordnets tall i NOK.</p>`;
  box.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-isin]"); if (!b) return;
    ev.stopPropagation(); toggleSelect(b.dataset.isin);
    b.classList.toggle("on"); b.textContent = b.classList.contains("on") ? "✓" : "+";
  });
  return box;
}

async function refreshFunds() {
  const list = FS.list.filter((f) => fundPasses(f, FS.f));
  FS.filtered = list;
  $("ff-count").textContent = `${num(list.length)} fond`;
  $("ff-cols-note").textContent = `Avkastning er Nordnets tall i NOK per ${dateNo(FS.data.as_of)}, per år (annualisert), etter fondets kostnader. ` +
    "Nordnets fondsside viser i stedet samlet avkastning i fondets egen valuta, så tallene der er ikke direkte sammenlignbare. " +
    `Risikotallene er Nordnets i NOK${FS.data.risk_fetched ? `, hentet ${dateNo(FS.data.risk_fetched)}` : ""}. ETF-tallene er totalavkastning i NOK til samme dato. ` +
    "Hold musen over en kolonneoverskrift for forklaring.";
  renderFundKpis(list);
  if (FS.table) { await FS.ready; await FS.table.replaceData(list.map(fundRow)); }
  renderFundChart();
}

// ---------------------------------------------------------------- method
function renderFundMethod() {
  const d = FS.data;
  $("fond-method").innerHTML = `
    <p><strong>Kilde:</strong> Nordnets fondsliste (${num(d.n)} fond, hentet ${dateNo(d.nordnet_run_at)}). Listen oppdateres månedlig sammen med ETF-ene.</p>
    <p><strong>Avkastning</strong> er Nordnets tall fra fondslisten for 1, 3, 5 og 10 år, regnet om til årlig avkastning (gir nøyaktig Nordnets
      egen «årlig vekst»). Tallene er i NOK også for fond som handles i USD, EUR eller SEK, er etter fondets kostnader og tar med utbytte.
      <em>Nordnets fondsside viser noe annet:</em> samlet kursutvikling i fondets egen valuta (for et USD- eller EUR-fond kan forskjellen være
      mange prosentpoeng når kronen har styrket eller svekket seg). Tallene gjelder fondets kurs per ${dateNo(d.as_of)} (de fleste fond; noen er en dag foran eller bak).</p>
    <p><strong>Risikotall</strong> (volatilitet, Sharpe, alfa og beta for 1, 3 og 5 år) hentes per fond fra Nordnets fond-API og er i NOK.
      For 10 år vises 5-årstallene. Alfa og beta er mot fondets referanseindeks og mangler for fond uten en (mest rente- og pengemarkedsfond).
      <strong>R²</strong> finnes bare på Nordnets fondsside, der Morningstar regner alle tall i SEK; R² tas derfor derfra, mens volatiliteten der
      ikke brukes (et norsk pengemarkedsfond får 6 % volatilitet i SEK mot 0,2 % i NOK). ${num(d.n_risk || 0)} av ${num(d.n)} fond har risikotall.
      ETF-fanens nøkkeltall er regnet mot valgt verdens-ETF, så alfa, beta og R² for fond og ETF-er er ikke direkte sammenlignbare; volatilitet og Sharpe er det.</p>
    <p><strong>Kostnad hos Nordnet</strong> = forvaltningshonorar − returprovisjon (det Nordnet betaler tilbake) + Nordnets plattformavgift.
      Det er Nordnets eget totaltall. Fond har ingen kurtasje.</p>
    <p><strong>ETF-sammenligningen</strong> bruker ETF-er hos Nordnet i samme Morningstar-kategori som fondet (én ETF per indeks, ASK-tillatt,
      ikke giret). ETF-avkastningen er totalavkastning i NOK regnet fra våre egne kurser til samme dato som fondstallene. Samme kategori betyr
      lignende marked, ikke samme indeks, så forskjellen sier noe om aktiv forvaltning og kostnad, men er ingen eksakt sammenligning.</p>
    <p><strong>Hvorfor ikke optimering og backtest for fond?</strong> Yahoo har bare kurser for fond fra rundt 2022, og for halvparten av fondene
      var tickeren feil andelsklasse. Hver månedlige kjøring lagrer fondets kurs, så egen historikk bygges opp over tid.</p>
    <p class="muted">Modellverktøy, ikke finansiell rådgivning. Historisk avkastning er ingen garanti for fremtidig avkastning.</p>`;
}

document.addEventListener("DOMContentLoaded", setupTabs);
