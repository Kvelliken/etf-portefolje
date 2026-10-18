/* ETF-portefølje – static site.
 * 1. Explorer: filter all Nordnet ETFs, 1/3/5/10-year metrics against a chosen world ETF.
 * 2. My selection: optimal weights with min/max bounds per ETF (computed here, see engine.js).
 * 3. Backtest of the selection against the reference (fixed weights or walk-forward).
 * Selection, filters and holdings live only in localStorage. */
"use strict";

const E = window.Engine;
const FILES = ["summary", "etfs", "returns", "changes", "quality"];
const PERIODS = [1, 3, 5, 10];
const LS = { theme: "etfpf.theme", filters: "etfpf.filters.v2", sel: "etfpf.selection.v2", hold: "etfpf.holdings.v1",
  bench: "etfpf.benchmark.v2", bt: "etfpf.backtest.v2" };
const OBJECTIVES = [["max_sharpe", "Maks Sharpe"], ["min_variance", "Minimum varians"], ["risk_parity", "Risikoparitet"],
  ["equal", "Lik vekt"], ["manual", "Manuell"]];
const DD = [["asset_class", "Aktivaklasse"], ["sector", "Sektor"], ["theme", "Tema"], ["region", "Region"], ["style", "Stil"], ["issuer", "Utsteder"]];
const NONE = "(ingen)";
const CHANGE = { new: "Ny", gone: "Utgått", reappeared: "Tilbake", changed: "Endret" };

const D = {};
const st = {
  period: 5, chartTab: "scatter", bench: null,
  f: null, sel: null, bt: null, result: null, btres: null, holdings: null,
};
const redraw = [];

// ---------------------------------------------------------------- formatting (nb-NO)
const nfCache = {};
const nf = (d) => (nfCache[d] ||= new Intl.NumberFormat("nb-NO", { minimumFractionDigits: d, maximumFractionDigits: d }));
const ok = (x) => x !== null && x !== undefined && Number.isFinite(+x);
const pct = (x, d = 1) => (ok(x) ? nf(d).format(x * 100) + " %" : "–");
const pp = (x, d = 1) => {
  if (!ok(x)) return "–";
  const v = Math.round(x * 100 * 10 ** d) / 10 ** d;
  return (v > 0 ? "+" : "") + nf(d).format(v === 0 ? 0 : v) + " pp";
};
const num = (x, d = 0) => (ok(x) ? nf(d).format(x) : "–");
const kr = (x) => (ok(x) ? nf(0).format(Math.round(x)) + " kr" : "–");
const dateNo = (s) => { if (!s) return "–"; const [y, m, d] = String(s).slice(0, 10).split("-"); return `${d}.${m}.${y}`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const $ = (id) => document.getElementById(id);
const accLabel = (a) => (a === true ? "Akk." : a === false ? "Utd." : "–");
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function kpi(lbl, value, sub) {
  return `<div class="kpi"><div class="label">${esc(lbl)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}
function table(el, head, rows, opts = {}) {
  const th = head.map((h) => `<th class="${h.num ? "num" : ""} ${h.cls || ""}" scope="col"${h.title ? ` title="${esc(h.title)}"` : ""}>${esc(h.t)}</th>`).join("");
  const body = rows.map((r) => `<tr class="${r._cls || ""}">${r.cells.map((c, i) => `<td class="${head[i].num ? "num" : ""} ${head[i].cls || ""} ${c?.cls || ""}">${c?.html ?? esc(c)}</td>`).join("")}</tr>`).join("");
  el.innerHTML = `<thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${head.length}" class="muted">${opts.empty || "Ingen rader"}</td></tr>`}</tbody>`;
}
function notice(el, kind, html) {
  if (!html) { el.hidden = true; return; }
  el.hidden = false; el.className = "notice" + (kind ? " " + kind : ""); el.innerHTML = html;
}

// ---------------------------------------------------------------- Plotly base
const PCONF = { displayModeBar: false, responsive: true };
function axis(o = {}) {
  return Object.assign({
    gridcolor: css("--grid"), linecolor: css("--baseline"), zerolinecolor: css("--baseline"), showline: true,
    tickfont: { color: css("--axis"), size: 11 }, automargin: true,
    title: { text: o.titleText || "", font: { color: css("--ink-2"), size: 12 } },
  }, o);
}
function layout(o = {}) {
  return Object.assign({
    paper_bgcolor: css("--surface"), plot_bgcolor: css("--surface"),
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: css("--ink-2"), size: 12 },
    separators: ", ", margin: { l: 56, r: 16, t: 32, b: 48 },
    hoverlabel: { bgcolor: css("--surface"), bordercolor: css("--baseline"), font: { color: css("--ink"), size: 12 } },
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { color: css("--ink-2") } },
  }, o);
}
function plot(id, traces, lay) {
  const el = $(id);
  if (!el || !window.Plotly) return;
  Plotly.react(el, traces, lay, PCONF);
}
function emptyChart(id, text) {
  plot(id, [], layout({ xaxis: { visible: false }, yaxis: { visible: false },
    annotations: [{ text, showarrow: false, font: { color: css("--muted"), size: 13 }, xref: "paper", yref: "paper", x: 0.5, y: 0.5 }] }));
}

// ---------------------------------------------------------------- months
function monthYM(i) {           // month index -> {y, m}
  const y0 = +D.returns.start.slice(0, 4), m0 = +D.returns.start.slice(5, 7) - 1;
  const t = y0 * 12 + m0 + i;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}
function monthEnd(i) {          // "YYYY-MM-DD" (last day of month i; i may be -1)
  const { y, m } = monthYM(i);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function monthLabel(i) { const { y, m } = monthYM(i); return `${String(m).padStart(2, "0")}.${y}`; }

// ---------------------------------------------------------------- loading
async function load() {
  const res = await Promise.all(FILES.map((f) => fetch(`data/${f}.json`, { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(`${f}.json: HTTP ${r.status}`); return r.json(); })));
  FILES.forEach((f, i) => (D[f] = res[i]));
  D.list = D.etfs.etfs;
  D.by = Object.fromEntries(D.list.map((e) => [e.isin, e]));
  D.ret = E.decodeReturns(D.returns);
  D.n = D.returns.n;
  D.end = D.n - 1;
  D.rf = Float64Array.from(D.returns.rf);
  D.clusters = {};
  for (const e of D.list) {
    (D.clusters[e.cluster] ||= []).push(e.isin);
    e.f0 = D.ret[e.isin] ? E.firstIdx(D.ret[e.isin]) : -1;
    e.l0 = D.ret[e.isin] ? E.lastIdx(D.ret[e.isin]) : -1;
    e.size_m = ok(e.fund_size) ? e.fund_size / 1e6 : null;
  }
}

function init() {
  setupTheme();
  load().then(() => {
    const def = D.summary.defaults;
    st.bench = store.get(LS.bench, def.benchmark);
    if (!D.ret[st.bench]) st.bench = def.benchmark;
    st.f = Object.assign(defaultFilters(), store.get(LS.filters, {}));
    st.period = st.f.period || 5;
    st.sel = Object.assign({ items: [], objective: "max_sharpe", window: def.estimation_years * 12, hist: Math.round(def.history_weight * 100),
      premium: def.market_risk_premium * 100, extend: true }, store.get(LS.sel, {}));
    st.bt = Object.assign({ mode: "fixed", rule: "band", start: "auto", cost: def.trading_cost_pct, amount: def.portfolio_value_nok, log: false }, store.get(LS.bt, {}));
    st.holdings = store.get(LS.hold, { cash: 0, items: [] });
    readHash();
    renderHeader();
    setupBenchmark();
    computeMetrics();
    setupFilters();
    setupExplorer();
    setupSelection();
    setupBacktest();
    setupRebalancing();
    renderTips();
    renderQuality();
    renderMethod();
    renderChanges();
    refreshAll();
    redraw.push(renderExplorerChart, renderOptCharts, renderBacktestCharts);
  }).catch((e) => {
    notice($("load-error"), "critical", `<strong>⚠ Feil:</strong> Kunne ikke laste data (${esc(e.message)}). Siden krever filene i <code>data/</code>.`);
    console.error(e);
  });
}

function refreshAll() {
  refreshExplorer();
  runOptimization();
}

// ---------------------------------------------------------------- theme
function setupTheme() {
  const btn = $("theme-toggle");
  const isDark = () => document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const sync = () => { btn.textContent = isDark() ? "Lys modus" : "Mørk modus"; };
  btn.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(LS.theme, next); } catch (e) { /* private mode */ }
    sync();
    redraw.forEach((f) => f());
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { sync(); redraw.forEach((f) => f()); });
  sync();
}

// ---------------------------------------------------------------- header + benchmark
function renderHeader() {
  const s = D.summary;
  $("updated").textContent = `Kurser til ${dateNo(s.data_until)} · nøkkeltall per ${dateNo(s.returns_until)} · Nordnet hentet ${dateNo(s.nordnet_run_at)}`;
  if (s.account?.tax_warning) notice($("tax-warning"), "warning", "<strong>⚠ Skatt:</strong> Kontoen er ikke en aksjesparekonto (ASK). Salg ved ombalansering utløser gevinstskatt, som ikke er regnet med her.");
}

function benchmarkCandidates() {
  const c = D.list.filter((e) => e.has_returns && e.asset_class === "Aksjer" && e.region === "Global" && e.sector === "Bred" &&
    e.style === "Markedsvektet" && !e.hedged && !e.esg && !e.leveraged && e.history_years >= 5 && e.l0 === D.end);
  if (!c.find((e) => e.isin === st.bench) && D.by[st.bench]) c.push(D.by[st.bench]);
  return c.sort((a, b) => (b.fund_size || 0) - (a.fund_size || 0)).slice(0, 40);
}

function setupBenchmark() {
  const sel = $("benchmark");
  sel.innerHTML = benchmarkCandidates().map((e) => `<option value="${e.isin}">${esc(e.ticker)} – ${esc(e.name)} (${num(e.history_years, 0)} år, ${nf(2).format(e.fee)} %)</option>`).join("");
  sel.value = st.bench;
  sel.addEventListener("change", () => {
    st.bench = sel.value; store.set(LS.bench, st.bench);
    computeMetrics(); refreshAll();
  });
  renderSettingsNote();
}
function renderSettingsNote() {
  const s = D.summary;
  $("settings-note").innerHTML = `Alfa, beta, R², TE og informasjonsrate måles mot referansen. Månedlig totalavkastning i NOK.
    Risikofri rente: ${esc(s.rf_source)}, nå ${pct(s.rf_now, 2)}.`;
}

function benchSeries() { return D.ret[st.bench]; }

// ---------------------------------------------------------------- metrics per ETF
function computeMetrics() {
  const b = benchSeries();
  for (const e of D.list) {
    e.m = {};
    const r = D.ret[e.isin];
    for (const P of PERIODS) e.m[P] = r ? E.stats(r, b, D.rf, D.end, 12 * P) : null;
  }
}

// ---------------------------------------------------------------- filters
function defaultFilters() {
  return { q: "", dd: Object.fromEntries(DD.map(([k]) => [k, []])), hist: 0, fee: "", size: "", hedged: "all", acc: "all", esg: "all",
    pick: true, ask: true, lev: true, mine: false, top: 0, group: "sector", rank: "sharpe", period: 5 };
}
function saveFilters() { store.set(LS.filters, { ...st.f, period: st.period }); }

function setupFilters() {
  const F = st.f;
  // dropdowns
  const row = $("dd-row");
  row.innerHTML = DD.map(([k, label]) => `<details class="dd" data-k="${k}"><summary><span class="dd-label">${esc(label)}:</span><span class="dd-val">alle</span></summary><div class="dd-panel"></div></details>`).join("");
  row.querySelectorAll(".dd").forEach((dd) => {
    const k = dd.dataset.k;
    const counts = {};
    for (const e of D.list) { const v = e[k] ?? NONE; counts[v] = (counts[v] || 0) + 1; }
    const opts = Object.entries(counts).sort((a, b) => (a[0] === NONE) - (b[0] === NONE) || b[1] - a[1] || a[0].localeCompare(b[0], "nb"));
    dd.querySelector(".dd-panel").innerHTML = `<div class="dd-actions"><button type="button" data-a="all">Vis alle (fjern valg)</button></div>` +
      opts.map(([v, n]) => `<label><input type="checkbox" value="${esc(v)}" ${F.dd[k]?.includes(v) ? "checked" : ""}> ${esc(v)} <span class="n">${num(n)}</span></label>`).join("");
    dd.addEventListener("toggle", () => { if (dd.open) row.querySelectorAll(".dd[open]").forEach((o) => { if (o !== dd) o.open = false; }); });
    dd.querySelector(".dd-panel").addEventListener("change", () => {
      F.dd[k] = [...dd.querySelectorAll("input:checked")].map((i) => i.value);
      syncDD(); onFilter();
    });
    dd.querySelector(".dd-actions").addEventListener("click", (ev) => {
      const a = ev.target.dataset.a; if (!a) return;
      dd.querySelectorAll("input").forEach((i) => { i.checked = false; });
      F.dd[k] = []; syncDD(); onFilter();
    });
  });
  document.addEventListener("click", (ev) => { if (!ev.target.closest(".dd")) row.querySelectorAll(".dd[open]").forEach((o) => { o.open = false; }); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") row.querySelectorAll(".dd[open]").forEach((o) => { o.open = false; }); });

  const bind = (id, key, kind = "value", ev = "change") => {
    const el = $(id);
    if (kind === "checked") el.checked = !!F[key]; else el.value = F[key];
    el.addEventListener(ev, () => { F[key] = kind === "checked" ? el.checked : el.value; onFilter(); });
  };
  const s = $("f-search"); s.value = F.q; s.addEventListener("input", debounce(() => { F.q = s.value; onFilter(); }, 150));
  bind("f-hist", "hist"); bind("f-fee", "fee", "value", "input"); bind("f-size", "size", "value", "input");
  bind("f-hedged", "hedged"); bind("f-acc", "acc"); bind("f-esg", "esg");
  bind("f-pick", "pick", "checked"); bind("f-ask", "ask", "checked"); bind("f-lev", "lev", "checked"); bind("f-mine", "mine", "checked");
  bind("f-top", "top"); bind("f-group", "group"); bind("f-rank", "rank");
  $("f-reset").addEventListener("click", () => { store.set(LS.filters, defaultFilters()); location.reload(); });
  renderPeriodTabs();
  syncDD();
  const tabs = $("exp-chart-tabs");
  tabs.addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    st.chartTab = b.dataset.v;
    tabs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", x === b ? "true" : "false"));
    renderExplorerChart();
  });
}

function syncDD() {
  document.querySelectorAll("#dd-row .dd").forEach((dd) => {
    const v = st.f.dd[dd.dataset.k] || [];
    dd.querySelector(".dd-val").textContent = !v.length ? "alle" : v.length === 1 ? v[0] : `${v.length} valgt`;
    dd.classList.toggle("active", v.length > 0);
  });
}

function renderPeriodTabs() {
  const el = $("f-period");
  el.innerHTML = PERIODS.map((P) => `<button type="button" role="tab" data-p="${P}" aria-selected="${P === st.period}">${P} år</button>`).join("");
  el.onclick = (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    st.period = +b.dataset.p;
    el.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", x === b ? "true" : "false"));
    st.table && st.table.setColumns(explorerColumns());
    onFilter();
  };
}

const onFilter = debounce(() => { saveFilters(); refreshExplorer(); }, 60);

function mineSet() { return new Set(st.sel.items.map((i) => i.isin)); }

function passes(e, F, mine) {
  if (F.mine) return mine.has(e.isin);
  if (F.pick && !e.pick && !mine.has(e.isin)) return false;
  if (F.ask && !e.ask) return false;
  if (F.lev && (e.leveraged || e.asset_class === "Giret/invers")) return false;
  for (const [k] of DD) { const sel = F.dd[k]; if (sel && sel.length && !sel.includes(e[k] ?? NONE)) return false; }
  if (+F.hist > 0 && !(e.history_years >= +F.hist)) return false;
  if (F.fee !== "" && ok(+F.fee) && !(e.fee <= +F.fee)) return false;
  if (F.size !== "" && ok(+F.size) && !(e.size_m >= +F.size)) return false;
  if (F.hedged === "yes" && !e.hedged) return false;
  if (F.hedged === "no" && e.hedged) return false;
  if (F.acc === "acc" && e.acc !== true) return false;
  if (F.acc === "dist" && e.acc !== false) return false;
  if (F.esg === "yes" && !e.esg) return false;
  if (F.esg === "no" && e.esg) return false;
  if (F.q) { const q = F.q.trim().toLowerCase(); if (q && ![e.name, e.ticker, e.isin].some((v) => String(v || "").toLowerCase().includes(q))) return false; }
  return true;
}

const RANK = {
  sharpe: (m) => m?.sharpe, alpha: (m) => m?.alpha, ir: (m) => m?.ir, ret: (m) => m?.ret,
  vol_low: (m) => (ok(m?.vol) ? -m.vol : null), mdd_low: (m) => m?.mdd, fee_low: (m, e) => (ok(e.fee) ? -e.fee : null),
};

function filteredEtfs() {
  const F = st.f, mine = mineSet();
  let list = D.list.filter((e) => passes(e, F, mine));
  const top = +F.top;
  if (top > 0) {
    const key = RANK[F.rank] || RANK.sharpe, groups = {};
    for (const e of list) {
      const v = key(e.m?.[st.period], e);
      if (!ok(v)) continue;
      (groups[e[F.group] ?? NONE] ||= []).push([v, e]);
    }
    list = Object.values(groups).flatMap((g) => g.sort((a, b) => b[0] - a[0]).slice(0, top).map((x) => x[1]));
  }
  return list;
}

function rowOf(e, mine) {
  const m = e.m?.[st.period] || {};
  return {
    isin: e.isin, ticker: e.ticker, name: e.name, sector: e.sector, theme: e.theme, region: e.region, style: e.style,
    asset_class: e.asset_class, category: e.category, issuer: e.issuer, fee: e.fee, size: e.size_m, history_years: e.history_years,
    acc: e.acc, hedged: e.hedged, esg: e.esg, cluster: e.cluster, cluster_size: e.cluster_size, mine: mine.has(e.isin),
    r1: e.m?.[1]?.ret ?? null, r3: e.m?.[3]?.ret ?? null, r5: e.m?.[5]?.ret ?? null, r10: e.m?.[10]?.ret ?? null,
    vol: m.vol ?? null, sharpe: m.sharpe ?? null, alpha: m.alpha ?? null, beta: m.beta ?? null, r2: m.r2 ?? null,
    te: m.te ?? null, ir: m.ir ?? null, mdd: m.mdd ?? null, _group: e[st.f.group] ?? NONE,
  };
}

// ---------------------------------------------------------------- explorer table
function explorerColumns() {
  const sorterNull = (a, b, aRow, bRow, col, dir) => {
    const na = !ok(a), nb = !ok(b);
    if (na && nb) return 0;
    if (na) return dir === "asc" ? 1 : -1;
    if (nb) return dir === "asc" ? -1 : 1;
    return a - b;
  };
  const pctCol = (title, field, d = 1, tip) => ({ title, field, hozAlign: "right", cssClass: "num", sorter: sorterNull, headerTooltip: tip,
    formatter: (c) => { const v = c.getValue(); return ok(v) && v < 0 ? `<span class="neg">${pct(v, d)}</span>` : pct(v, d); } });
  const numCol = (title, field, d = 2, tip, mult = 1) => ({ title, field, hozAlign: "right", cssClass: "num", sorter: sorterNull, headerTooltip: tip,
    formatter: (c) => num(ok(c.getValue()) ? c.getValue() * mult : null, d) });
  const txt = (title, field, width) => ({ title, field, width, formatter: (c) => esc(c.getValue() ?? "–"), tooltip: true });
  const P = st.period;
  return [
    { title: "", field: "mine", frozen: true, headerSort: false, hozAlign: "center", width: 44,
      formatter: (c) => `<button type="button" class="add-btn ${c.getValue() ? "on" : ""}" aria-label="${c.getValue() ? "Fjern fra" : "Legg til i"} utvalget">${c.getValue() ? "✓" : "+"}</button>`,
      cellClick: (ev, c) => { ev.stopPropagation(); toggleSelect(c.getRow().getData().isin); } },
    { title: "Ticker", field: "ticker", frozen: true, formatter: (c) => `<strong>${esc(c.getValue())}</strong>` },
    txt("Navn", "name", 250), txt("Sektor", "sector", 130), txt("Tema", "theme", 130), txt("Region", "region", 100),
    { title: "Avgift", field: "fee", hozAlign: "right", cssClass: "num", sorter: sorterNull, headerTooltip: "Årlig kostnad (TER), %",
      formatter: (c) => (ok(c.getValue()) ? nf(2).format(c.getValue()) + " %" : "–") },
    numCol("Str. (mill.)", "size", 0, "Fondsstørrelse i millioner (fondets valuta, fra Nordnet)"),
    numCol("Hist. (år)", "history_years", 1, "Lengde på renset kurshistorikk"),
    { title: "Annualisert avkastning", columns: [pctCol("1 år", "r1"), pctCol("3 år", "r3"), pctCol("5 år", "r5"), pctCol("10 år", "r10")] },
    { title: `Risiko og mot referansen, ${P} år`, columns: [
      pctCol("Vol.", "vol", 1, "Volatilitet: årlig standardavvik av månedsavkastningen"),
      numCol("Sharpe", "sharpe", 2, "(Avkastning − risikofri rente) / volatilitet"),
      pctCol("Alfa", "alpha", 1, "Jensens alfa mot referansen, annualisert: avkastning utover det beta forklarer"),
      numCol("Beta", "beta", 2, "Følsomhet for referansen: 1,2 = svinger 20 % mer enn verdensindeksen"),
      numCol("R²", "r2", 0, "Andel av svingningene som forklares av referansen (0–100). Lav R² = diversifiserer", 100),
      pctCol("TE", "te", 1, "Tracking error: årlig standardavvik av differansen mot referansen"),
      numCol("IR", "ir", 2, "Informasjonsrate: meravkastning mot referansen / tracking error"),
      pctCol("Maks fall", "mdd", 0, "Største fall fra topp (månedsdata)"),
    ] },
    txt("Stil", "style", 120), txt("Aktivaklasse", "asset_class", 110), txt("Utsteder", "issuer", 140), txt("Kategori", "category", 190),
    { title: "Akk./utd.", field: "acc", formatter: (c) => accLabel(c.getValue()) },
    { title: "Sikret", field: "hedged", hozAlign: "center", formatter: (c) => (c.getValue() ? "ja" : "") },
    { title: "Lik indeks", field: "cluster_size", hozAlign: "right", cssClass: "num", headerTooltip: "Antall ETF-er hos Nordnet som følger samme indeks (klikk raden)",
      formatter: (c) => (c.getValue() > 1 ? `${c.getValue()}` : "") },
  ];
}

function setupExplorer() {
  if (!window.Tabulator) { $("explorer").innerHTML = '<p class="muted">Tabellbiblioteket kunne ikke lastes.</p>'; return; }
  st.table = new Tabulator("#explorer", {
    data: [], index: "isin", layout: "fitDataFill", maxHeight: "640px", placeholder: "Ingen treff – løsne på filtrene",
    columns: explorerColumns(), initialSort: [{ column: "sharpe", dir: "desc" }], columnHeaderVertAlign: "bottom",
    groupHeader: (value, count) => `${esc(value)}<span>(${count})</span>`,
    rowFormatter: (row) => row.getElement().classList.toggle("is-mine", !!row.getData().mine),
  });
  st.tableReady = new Promise((res) => st.table.on("tableBuilt", res));
  st.table.on("dataSorted", () => { if (st.chartTab === "growth") renderExplorerChart(); });
  st.table.on("rowClick", (e, row) => {
    if (e.target.closest("a,button")) return;
    const el = row.getElement();
    const open = el.querySelector(".alt-box");
    if (open) { open.remove(); row.normalizeHeight(); return; }
    const d = D.by[row.getData().isin];
    const alts = (D.clusters[d.cluster] || []).filter((i) => i !== d.isin).map((i) => D.by[i]);
    const box = document.createElement("div");
    box.className = "alt-box";
    box.innerHTML = alts.length
      ? `<strong>${alts.length} andre ETF-er følger samme indeks</strong> (største parvise tracking error ${pct(d.max_te, 2)})
         <table class="data"><thead><tr><th></th><th>Ticker</th><th>Navn</th><th class="num">Avgift</th><th>Akk./utd.</th><th class="num">Historikk</th><th class="num">${st.period} år avk.</th><th>ASK</th></tr></thead><tbody>
         ${alts.sort((a, b) => (a.fee ?? 9) - (b.fee ?? 9)).map((x) => `<tr><td><button type="button" class="add-btn ${mineSet().has(x.isin) ? "on" : ""}" data-isin="${x.isin}" aria-label="Legg til">${mineSet().has(x.isin) ? "✓" : "+"}</button></td>
           <td>${esc(x.ticker)}${x.pick ? ' <span class="tag">vist</span>' : ""}</td><td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>` : esc(x.name)}</td>
           <td class="num">${ok(x.fee) ? nf(2).format(x.fee) + " %" : "–"}</td><td>${accLabel(x.acc)}</td><td class="num">${num(x.history_years, 1)} år</td>
           <td class="num">${pct(x.m?.[st.period]?.ret)}</td><td>${x.ask ? "ja" : "nei"}</td></tr>`).join("")}
         </tbody></table>`
      : `<span class="muted">Ingen andre ETF-er hos Nordnet følger samme indeks.</span> ${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">Åpne hos Nordnet</a>` : ""}`;
    box.addEventListener("click", (ev) => { const b = ev.target.closest("button[data-isin]"); if (b) { ev.stopPropagation(); toggleSelect(b.dataset.isin); b.classList.toggle("on"); b.textContent = b.classList.contains("on") ? "✓" : "+"; } });
    el.appendChild(box);
    row.normalizeHeight();
  });
}

async function refreshExplorer() {
  const list = filteredEtfs();
  st.filtered = list;
  const mine = mineSet();
  const rows = list.map((e) => rowOf(e, mine));
  $("f-count").textContent = `${num(rows.length)} ETF-er`;
  $("exp-cols-note").textContent = `Annualisert avkastning per ${dateNo(D.summary.returns_until)}. Risikotall gjelder ${st.period} år; tomme felt betyr for kort historikk. ` +
    "Hold musen over en kolonneoverskrift for forklaring.";
  if (st.table) {
    await st.tableReady;
    st.table.setGroupBy(+st.f.top > 0 ? "_group" : false);
    await st.table.replaceData(rows);
  }
  renderExplorerChart();
}

function renderExplorerChart() {
  if (!st.filtered) return;
  if (st.chartTab === "growth") return renderGrowthChart();
  const P = st.period, mine = mineSet();
  const pts = st.filtered.filter((e) => ok(e.m?.[P]?.vol) && ok(e.m?.[P]?.ret));
  const bm = D.by[st.bench]?.m?.[P];
  $("exp-chart-note").textContent = `${num(pts.length)} ETF-er med ${P} års historikk. Klikk på en prikk for å legge den i utvalget.`;
  if (!pts.length) return emptyChart("chart-explorer", "Ingen ETF-er med nok historikk for perioden");
  const mk = (arr) => ({
    x: arr.map((e) => e.m[P].vol * 100), y: arr.map((e) => e.m[P].ret * 100), customdata: arr.map((e) => e.isin),
    text: arr.map((e) => `<b>${esc(e.ticker)}</b> ${esc(e.name)}<br>${esc(e.sector)}${e.theme ? " · " + esc(e.theme) : ""} · ${esc(e.region)}<br>` +
      `Avkastning ${pct(e.m[P].ret)} · vol. ${pct(e.m[P].vol)} · Sharpe ${num(e.m[P].sharpe, 2)}<br>Alfa ${pct(e.m[P].alpha)} · beta ${num(e.m[P].beta, 2)} · R² ${num(ok(e.m[P].r2) ? e.m[P].r2 * 100 : null, 0)}`),
    hovertemplate: "%{text}<extra></extra>",
  });
  const others = pts.filter((e) => !mine.has(e.isin) && e.isin !== st.bench), mineP = pts.filter((e) => mine.has(e.isin));
  const traces = [
    { ...mk(others), type: "scatter", mode: "markers", name: "ETF-er i filteret", marker: { color: css("--dot"), size: 8, line: { color: css("--surface"), width: 1 } } },
    { ...mk(mineP), type: "scatter", mode: "markers+text", name: "Mitt utvalg", textposition: "top center", texttemplate: mineP.map((e) => esc(e.ticker)),
      textfont: { color: css("--ink-2"), size: 11 }, marker: { color: css("--mine"), size: 11, symbol: "diamond", line: { color: css("--surface"), width: 2 } } },
  ];
  if (bm) traces.push({ type: "scatter", mode: "markers+text", name: "Referanse", x: [bm.vol * 100], y: [bm.ret * 100], customdata: [st.bench],
    text: [`<b>Referanse</b> ${esc(D.by[st.bench].name)}<br>Avkastning ${pct(bm.ret)} · vol. ${pct(bm.vol)} · Sharpe ${num(bm.sharpe, 2)}`],
    texttemplate: ["Referanse"], textposition: "bottom right", textfont: { color: css("--ink-2"), size: 11 }, hovertemplate: "%{text}<extra></extra>",
    marker: { color: css("--ref"), size: 13, symbol: "circle", line: { color: css("--surface"), width: 2 } } });
  plot("chart-explorer", traces, layout({
    hovermode: "closest", xaxis: axis({ ticksuffix: " %", titleText: `Volatilitet per år, ${P} år`, rangemode: "tozero" }),
    yaxis: axis({ ticksuffix: " %", titleText: `Annualisert avkastning, ${P} år` }),
  }));
  const el = $("chart-explorer");
  if (!el._clickBound && el.on) {
    el.on("plotly_click", (ev) => { const i = ev.points?.[0]?.customdata; if (i && i !== st.bench) toggleSelect(i); });
    el._clickBound = true;
  }
}

function renderGrowthChart() {
  const P = st.period, len = 12 * P, start = D.end - len + 1, mine = mineSet();
  let rows = st.table ? st.table.getRows("active").map((r) => r.getData()) : [];
  rows = rows.filter((r) => D.ret[r.isin] && ok(D.by[r.isin].m?.[P]?.ret)).slice(0, 10);
  $("exp-chart-note").textContent = `De 10 første radene i tabellen (etter sorteringen din), ${P} år. Verdi av 100 kr.`;
  if (!rows.length) return emptyChart("chart-explorer", "Ingen ETF-er med nok historikk for perioden");
  const dates = []; for (let i = start - 1; i <= D.end; i++) dates.push(monthEnd(i));
  const series = rows.map((r) => ({ isin: r.isin, label: r.ticker, name: r.name, mine: mine.has(r.isin), v: E.cumulative(D.ret[r.isin], start, D.end, 100) }));
  const b = benchSeries();
  if (b && E.isNum(b[start])) series.push({ isin: st.bench, label: "Referanse", name: D.by[st.bench].name, ref: true, v: E.cumulative(b, start, D.end, 100) });
  const traces = series.map((s) => ({
    x: dates, y: s.v, mode: "lines", name: s.label, showlegend: false,
    line: { color: s.ref ? css("--ref") : s.mine ? css("--mine") : css("--axis"), width: s.ref || s.mine ? 2.5 : 1.5 },
    hovertemplate: `%{y:.0f}<extra>${esc(s.label)}</extra>`,
  }));
  // direct labels at the line ends, nudged apart
  const ends = series.map((s, k) => ({ k, y: s.v[s.v.length - 1] })).sort((a, b) => a.y - b.y);
  const ys = series.flatMap((s) => s.v), lo = Math.min(...ys), hi = Math.max(...ys);
  const useLog = hi / lo > 4, tr = (v) => (useLog ? Math.log10(v) : v);
  const gap = (tr(hi) - tr(lo)) * 0.045;
  let last = -Infinity;
  for (const e of ends) { e.p = Math.max(tr(e.y), last + gap); last = e.p; }
  const ann = ends.map((e) => ({ x: dates[dates.length - 1], y: useLog ? e.p : e.p, xanchor: "left", yanchor: "middle", showarrow: false, xshift: 6,
    text: esc(series[e.k].label), font: { size: 11, color: series[e.k].ref ? css("--ink") : css("--ink-2") } }));
  plot("chart-explorer", traces, layout({
    hovermode: "x unified", margin: { l: 56, r: 90, t: 16, b: 40 }, annotations: ann,
    xaxis: axis({ type: "date", tickformat: P <= 1 ? "%m.%Y" : "%Y", dtick: P <= 1 ? "M2" : P <= 5 ? "M12" : "M24", range: [dates[0], dates[dates.length - 1]] }),
    yaxis: axis({ titleText: "Verdi av 100 kr", type: useLog ? "log" : "linear" }),
  }));
}

// ---------------------------------------------------------------- selection
function saveSel() { store.set(LS.sel, st.sel); }

function toggleSelect(isin) {
  const i = st.sel.items.findIndex((x) => x.isin === isin);
  const def = D.summary.defaults;
  if (i >= 0) st.sel.items.splice(i, 1);
  else st.sel.items.push({ isin, min: def.min_weight, max: def.max_weight, w: 0 });
  saveSel();
  const mine = mineSet();
  if (st.table) {
    const row = st.table.searchRows("isin", "=", isin)[0];
    if (row) row.update({ mine: mine.has(isin) });
  }
  if (st.f.mine) refreshExplorer(); else renderExplorerChart();
  renderSelTable();
  runOptimization();
}

function setupSelection() {
  const S = st.sel;
  const obj = $("o-objective");
  obj.innerHTML = OBJECTIVES.map(([k, l]) => `<button type="button" role="tab" data-k="${k}" aria-selected="${S.objective === k}">${esc(l)}</button>`).join("");
  obj.addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    S.objective = b.dataset.k; obj.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", x === b ? "true" : "false"));
    saveSel(); renderSelTable(); runOptimization();
  });
  const w = $("o-window"); w.value = String(S.window); if (!w.value) { w.value = "60"; S.window = 60; }
  w.addEventListener("change", () => { S.window = +w.value; saveSel(); runOptimization(); });
  const h = $("o-hist"), hv = $("o-hist-v");
  h.value = S.hist; hv.textContent = `${S.hist} %`;
  h.addEventListener("input", () => { S.hist = +h.value; hv.textContent = `${S.hist} %`; saveSel(); runOptLater(); });
  const pr = $("o-premium"); pr.value = S.premium;
  pr.addEventListener("input", () => { if (ok(+pr.value)) { S.premium = +pr.value; saveSel(); runOptLater(); } });
  const ex = $("o-extend"); ex.checked = !!S.extend;
  ex.addEventListener("change", () => { S.extend = ex.checked; saveSel(); runOptimization(); });
  $("o-allmin").value = Math.round(D.summary.defaults.min_weight * 100);
  $("o-allmax").value = Math.round(D.summary.defaults.max_weight * 100);
  $("o-apply-all").addEventListener("click", () => {
    const lo = +$("o-allmin").value / 100, hi = +$("o-allmax").value / 100;
    S.items.forEach((it) => { if (ok(lo)) it.min = lo; if (ok(hi)) it.max = hi; });
    saveSel(); renderSelTable(); runOptimization();
  });
  $("o-add-core").addEventListener("click", () => {
    if (!S.items.find((x) => x.isin === st.bench)) S.items.unshift({ isin: st.bench, min: 0.4, max: 0.8, w: 0.5 });
    saveSel(); renderSelTable(); runOptimization(); refreshExplorer();
  });
  $("o-clear").addEventListener("click", () => {
    if (!S.items.length || !confirm("Fjerne alle ETF-er fra utvalget?")) return;
    S.items = []; saveSel(); renderSelTable(); runOptimization(); refreshExplorer();
  });
  $("o-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ version: 2, ...S }, null, 1)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "etf-utvalg.json" });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("o-import").addEventListener("change", (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    f.text().then((t) => {
      const j = JSON.parse(t);
      if (!Array.isArray(j.items)) throw new Error("mangler items");
      st.sel = Object.assign(st.sel, j, { items: j.items.filter((i) => D.by[i.isin]).map((i) => ({ isin: i.isin, min: +i.min || 0, max: ok(+i.max) ? +i.max : 1, w: +i.w || 0 })) });
      saveSel(); location.reload();
    }).catch((e) => alert("Kunne ikke lese filen: " + e.message));
    ev.target.value = "";
  });
  $("o-link").addEventListener("click", () => {
    const payload = { o: S.objective, i: S.items.map((x) => [x.isin, +x.min.toFixed(3), +x.max.toFixed(3), +(x.w || 0).toFixed(3)]) };
    const enc = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const url = `${location.origin}${location.pathname}#utvalg=${enc}`;
    (navigator.clipboard?.writeText(url) || Promise.reject()).then(() => alert("Lenken er kopiert. Den inneholder bare ISIN-er og grenser, ingen beløp."))
      .catch(() => prompt("Kopier lenken:", url));
  });
  renderSelTable();
}

function readHash() {
  const m = location.hash.match(/utvalg=([A-Za-z0-9_-]+)/);
  if (!m) return;
  try {
    const j = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")))));
    const items = (j.i || []).filter((x) => D.by[x[0]]).map((x) => ({ isin: x[0], min: +x[1] || 0, max: ok(+x[2]) ? +x[2] : 1, w: +x[3] || 0 }));
    if (items.length && (!st.sel.items.length || confirm("Lenken inneholder et utvalg. Erstatte utvalget ditt med det?"))) {
      st.sel.items = items; if (j.o) st.sel.objective = j.o; saveSel();
    }
  } catch (e) { console.warn("Ugyldig utvalg i lenken", e); }
  history.replaceState(null, "", location.pathname + location.search);
}

function renderSelTable() {
  const S = st.sel, res = st.result, manual = S.objective === "manual";
  const wOf = (isin) => (res && res.isins ? res.w[res.isins.indexOf(isin)] : null);
  const head = [{ t: "ETF" }, { t: "Sektor · region", cls: "hide-narrow" }, { t: "Historikk", num: true, cls: "hide-narrow" },
    { t: "Min. %", num: true }, { t: "Maks %", num: true }];
  if (manual) head.push({ t: "Manuell %", num: true });
  head.push({ t: "Vekt", num: true }, { t: "" });
  const rows = S.items.map((it, k) => {
    const e = D.by[it.isin] || {};
    const w = wOf(it.isin);
    const ext = res?.ext?.[it.isin];
    const cells = [
      { html: `<strong>${esc(e.ticker)}</strong> <span class="muted hide-narrow">${esc(e.name)}</span>${it.isin === st.bench ? ' <span class="tag">referanse</span>' : ""}` },
      { html: `${esc(e.sector || "")} · ${esc(e.region || "")}${e.theme ? ` <span class="tag">${esc(e.theme)}</span>` : ""}` },
      { html: `${num(e.history_years, 1)} år${ext ? `<br><span class="muted small-text">+${num(ext / 12, 1)} år forlenget</span>` : ""}` },
      { html: `<input type="number" min="0" max="100" step="1" data-k="${k}" data-f="min" value="${+(it.min * 100).toFixed(1)}" aria-label="Minimum for ${esc(e.ticker)}">` },
      { html: `<input type="number" min="0" max="100" step="1" data-k="${k}" data-f="max" value="${+(it.max * 100).toFixed(1)}" aria-label="Maksimum for ${esc(e.ticker)}">` },
    ];
    if (manual) cells.push({ html: `<input type="number" min="0" max="100" step="1" data-k="${k}" data-f="w" value="${+((it.w || 0) * 100).toFixed(1)}" aria-label="Manuell vekt for ${esc(e.ticker)}">` });
    cells.push({ html: ok(w) ? `${pct(w)}<span class="wbar" style="width:${Math.round(w * 60)}px"></span>` : "–" },
      { html: `<button class="btn icon" type="button" data-rm="${k}" aria-label="Fjern ${esc(e.ticker)}">✕</button>` });
    return { cells };
  });
  if (S.items.length) {
    const sl = S.items.reduce((s, x) => s + x.min, 0), sh = S.items.reduce((s, x) => s + x.max, 0);
    const tot = [{ html: "<strong>Sum</strong>" }, "", "", { html: pct(sl, 0) }, { html: pct(sh, 0) }];
    if (manual) tot.push({ html: pct(S.items.reduce((s, x) => s + (x.w || 0), 0), 0) });
    tot.push({ html: res?.w ? pct(1, 0) : "–" }, "");
    rows.push({ _cls: "total", cells: tot });
  }
  table($("sel-table"), head, rows, { empty: "Utvalget er tomt. Legg til ETF-er med + i utforskeren (eller klikk på prikker i grafen)." });
  $("sel-table").querySelectorAll("input[data-k]").forEach((inp) => inp.addEventListener("input", () => {
    const it = S.items[+inp.dataset.k], v = +inp.value / 100;
    if (!ok(v)) return;
    it[inp.dataset.f] = Math.min(1, Math.max(0, v));
    saveSel(); runOptLater();
  }));
  $("sel-table").querySelectorAll("button[data-rm]").forEach((b) => b.addEventListener("click", () => toggleSelect(S.items[+b.dataset.rm].isin)));
}

// ---------------------------------------------------------------- estimation + optimisation
function seriesFor(isin, extend) {
  const own = D.ret[isin];
  if (!own) return null;
  if (!extend) return { s: own, ext: 0 };
  const donors = (D.clusters[D.by[isin].cluster] || []).filter((i) => i !== isin && D.ret[i])
    .sort((a, b) => D.by[a].f0 - D.by[b].f0).map((i) => D.ret[i]);
  if (!donors.length) return { s: own, ext: 0 };
  const r = E.extend(own, donors);
  return { s: r.s, ext: r.filled.reduce((a, b) => a + b, 0) };
}

/** Estimate mu and covariance from months [from, to] for the given series (+ benchmark for beta). */
function estimate(series, bench, from, to) {
  const X = [];
  for (let t = from; t <= to; t++) X.push([...series.map((s) => s[t]), bench[t]]);
  const lw = E.ledoitWolfCC(X);
  const n = series.length, nb = n;                      // benchmark is the last column
  const S = lw.S.slice(0, n).map((row) => Float64Array.from(row.slice(0, n), (v) => v * 12));
  const beta = Float64Array.from({ length: n }, (_, i) => lw.S[i][nb] / lw.S[nb][nb]);
  const hist = Float64Array.from({ length: n }, (_, i) => { let s = 0; for (const row of X) s += row[i]; return (s / X.length) * 12; });
  let hb = 0; for (const row of X) hb += row[nb]; hb = (hb / X.length) * 12;
  return { S, beta, hist, benchVar: lw.S[nb][nb] * 12, benchHist: hb, delta: lw.delta };
}

function optimizeAt(series, bench, from, to, items, objective) {
  const S = st.sel, rf = D.summary.rf_now, prem = S.premium / 100, h = S.hist / 100;
  const est = estimate(series, bench, from, to);
  const mu = E.expectedReturns(est.hist, est.beta, rf, prem, h);
  const lo = Float64Array.from(items, (x) => x.min), hi = Float64Array.from(items, (x) => x.max);
  const manual = items.map((x) => x.w || 0);
  const res = E.optimize(objective, mu, est.S, lo, hi, rf, manual);
  return { ...res, mu, est, lo, hi, rf, benchMu: (1 - h) * (rf + prem) + h * est.benchHist };
}

const runOptLater = debounce(() => runOptimization(), 200);

function runOptimization() {
  const S = st.sel, status = $("opt-status");
  const items = S.items.filter((x) => D.ret[x.isin]);
  const bench = seriesFor(st.bench, S.extend)?.s;
  st.result = null;
  if (!items.length) {
    notice(status, "", "ℹ Legg til ETF-er i utvalget for å beregne optimale andeler og backteste.");
    $("opt-kpis").innerHTML = "";
    renderSelTable(); renderOptCharts(); runBacktest(); computeRebalancing();
    return;
  }
  const notes = [];
  const missing = S.items.filter((x) => !D.ret[x.isin]);
  if (missing.length) notes.push(`${missing.map((x) => D.by[x.isin]?.ticker || x.isin).join(", ")} mangler kursdata og er utelatt.`);
  const ser = items.map((x) => seriesFor(x.isin, S.extend));
  const stale = items.filter((x, k) => E.lastIdx(ser[k].s) < D.end);
  if (stale.length) notes.push(`${stale.map((x) => D.by[x.isin].ticker).join(", ")} mangler de siste månedene (behandles som 0 % avkastning der).`);
  const f0 = Math.max(...ser.map((s) => E.firstIdx(s.s)), E.firstIdx(bench));
  const avail = D.end - f0 + 1;
  const W = Math.min(S.window, avail);
  if (avail < 24) {
    notice(status, "critical", `<strong>⚠ For kort felles historikk:</strong> ETF-ene har bare ${avail} felles måneder (minst 24 trengs). ` +
      `Kortest: ${items.map((x, k) => [x, E.firstIdx(ser[k].s)]).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([x]) => D.by[x.isin].ticker).join(", ")}. Prøv «Forleng kort historikk».`);
    $("opt-kpis").innerHTML = ""; renderSelTable(); renderOptCharts(); runBacktest(); computeRebalancing();
    return;
  }
  if (W < S.window && S.window < 999) {
    const shortest = items.map((x, k) => [x, E.firstIdx(ser[k].s)]).sort((a, b) => b[1] - a[1])[0][0];
    notes.push(`Vinduet er kortet ned til ${num(W / 12, 1)} år fordi ${esc(D.by[shortest.isin].ticker)} har kortest historikk.`);
  }
  const from = D.end - W + 1;
  const res = optimizeAt(ser.map((s) => s.s), bench, from, D.end, items, S.objective);
  if (res.error) {
    notice(status, "critical", `<strong>⚠ ${esc(res.error)}</strong>`);
    $("opt-kpis").innerHTML = ""; renderSelTable(); renderOptCharts(); runBacktest(); computeRebalancing();
    return;
  }
  if (res.note) notes.push(res.note);
  const ext = {};
  items.forEach((x, k) => { if (ser[k].ext && E.firstIdx(D.ret[x.isin]) > from) ext[x.isin] = Math.min(ser[k].ext, E.firstIdx(D.ret[x.isin]) - from); });
  if (Object.keys(ext).length) notes.push(`Forlenget med ETF på samme indeks: ${Object.keys(ext).map((i) => D.by[i].ticker).join(", ")}.`);
  st.result = { isins: items.map((x) => x.isin), items, w: res.w, mu: res.mu, S: res.est.S, beta: res.est.beta, hist: res.est.hist, lo: res.lo, hi: res.hi,
    rf: res.rf, W, from, ext, frontier: res.frontier, benchMu: res.benchMu, benchVol: Math.sqrt(res.est.benchVar), series: ser.map((s) => s.s), bench };
  const p = E.perf(res.w, res.mu, res.est.S, res.rf);
  st.result.perf = p;
  // realised in the window with these weights (monthly rebalanced)
  const pr = new Float64Array(W); for (let t = 0; t < W; t++) { let s = 0; ser.forEach((x, k) => { s += res.w[k] * x.s[from + t]; }); pr[t] = s; }
  const bw = bench.slice(from, D.end + 1), rfw = D.rf.slice(from, D.end + 1);
  const hs = E.stats(pr, bw, rfw, W - 1, W);
  const fee = items.reduce((s, x, k) => s + res.w[k] * (D.by[x.isin].fee || 0), 0);
  const betaP = E.dot(res.w, res.est.beta);
  notice(status, notes.length ? "warning" : "", `${notes.length ? "⚠ " : "ℹ "}Estimert på ${num(W)} måneder (${monthLabel(from)}–${monthLabel(D.end)}), Ledoit-Wolf-krympet kovarians. ` +
    `Forventet avkastning = ${100 - S.hist} % likevekt (risikofri ${pct(res.rf, 1)} + beta × ${nf(1).format(S.premium)} %) + ${S.hist} % historisk snitt. ${notes.join(" ")}`);
  $("opt-kpis").innerHTML = [
    kpi("Forventet avkastning", pct(p.ret), `modell · referansen ${pct(res.benchMu)}`),
    kpi("Forventet volatilitet", pct(p.vol), `referansen ${pct(st.result.benchVol)}`),
    kpi("Forventet Sharpe", num(p.sharpe, 2), `referansen ${num((res.benchMu - res.rf) / st.result.benchVol, 2)}`),
    kpi("Historisk avkastning", pct(hs?.ret), `i vinduet · referansen ${pct(hs ? hs.ret - hs.excess : null)}`),
    kpi("Beta mot referansen", num(betaP, 2), `R² ${num(ok(hs?.r2) ? hs.r2 * 100 : null, 0)} i vinduet`),
    kpi("Vektet avgift", nf(2).format(fee) + " %", `${res.w.filter((x) => x > 0.005).length} av ${items.length} ETF-er brukt`),
  ].join("");
  renderSelTable();
  renderOptCharts();
  runBacktest();
  computeRebalancing();
}

function renderOptCharts() {
  const R = st.result;
  if (!R) { ["chart-weights", "chart-frontier", "chart-corr", "chart-rc"].forEach((id) => emptyChart(id, "Ingen beregning ennå")); return; }
  const lab = R.isins.map((i) => D.by[i].ticker);
  const order = [...R.w.keys()].sort((a, b) => R.w[a] - R.w[b]);
  plot("chart-weights", [{
    type: "bar", orientation: "h", y: order.map((k) => lab[k]), x: order.map((k) => R.w[k] * 100), marker: { color: css("--mine") },
    customdata: order.map((k) => [R.lo[k] * 100, R.hi[k] * 100, D.by[R.isins[k]].name]),
    hovertemplate: "%{customdata[2]}<br>Vekt %{x:.1f} % (tillatt %{customdata[0]:.0f}–%{customdata[1]:.0f} %)<extra></extra>",
    error_x: { type: "data", symmetric: false, array: order.map((k) => (R.hi[k] - R.w[k]) * 100), arrayminus: order.map((k) => (R.w[k] - R.lo[k]) * 100),
      color: css("--ink-2"), thickness: 1.5, width: 4 },
  }], layout({ margin: { l: 80, r: 16, t: 8, b: 40 }, bargap: 0.35, xaxis: axis({ ticksuffix: " %", rangemode: "tozero" }), yaxis: axis({ showgrid: false }) }));

  const fr = R.frontier || E.frontier(R.mu, R.S, R.lo, R.hi, R.rf, 30).points;
  const fpts = fr.filter((p) => isFinite(p.vol)).sort((a, b) => a.vol - b.vol);
  const vol = (k) => Math.sqrt(R.S[k][k]);
  plot("chart-frontier", [
    { x: fpts.map((p) => p.vol * 100), y: fpts.map((p) => p.ret * 100), mode: "lines", name: "Frontier (dine grenser)", line: { color: css("--mine"), width: 2 },
      hovertemplate: "Vol. %{x:.1f} % · avk. %{y:.1f} %<extra>Frontier</extra>" },
    { x: R.isins.map((_, k) => vol(k) * 100), y: R.isins.map((_, k) => R.mu[k] * 100), mode: "markers+text", name: "ETF-ene", text: lab, textposition: "top center",
      textfont: { color: css("--ink-2"), size: 11 }, marker: { color: css("--dot"), size: 9, line: { color: css("--surface"), width: 1 } },
      customdata: R.isins.map((i) => D.by[i].name), hovertemplate: "%{customdata}<br>Vol. %{x:.1f} % · forventet %{y:.1f} %<extra></extra>" },
    { x: [R.benchVol * 100], y: [R.benchMu * 100], mode: "markers+text", name: "Referanse", text: ["Referanse"], textposition: "bottom right",
      textfont: { color: css("--ink-2"), size: 11 }, marker: { color: css("--ref"), size: 12, line: { color: css("--surface"), width: 2 } },
      hovertemplate: "Referanse<br>Vol. %{x:.1f} % · forventet %{y:.1f} %<extra></extra>" },
    { x: [R.perf.vol * 100], y: [R.perf.ret * 100], mode: "markers+text", name: "Valgt portefølje", text: ["Din portefølje"], textposition: "middle left",
      textfont: { color: css("--ink"), size: 12 }, marker: { color: css("--mine"), size: 16, symbol: "star", line: { color: css("--surface"), width: 2 } },
      hovertemplate: "Din portefølje<br>Vol. %{x:.1f} % · forventet %{y:.1f} %<extra></extra>" },
  ], layout({ hovermode: "closest", xaxis: axis({ ticksuffix: " %", titleText: "Forventet volatilitet", rangemode: "tozero" }),
    yaxis: axis({ ticksuffix: " %", titleText: "Forventet avkastning" }) }));

  const n = R.isins.length;
  const corr = R.S.map((row, a) => Array.from(row, (v, b) => v / Math.sqrt(R.S[a][a] * R.S[b][b])));
  const names = R.isins.map((i) => D.by[i].name);
  plot("chart-corr", [{
    type: "heatmap", z: corr, x: lab, y: lab, zmin: -1, zmax: 1,
    colorscale: [[0, css("--div-neg")], [0.5, css("--div-mid")], [1, css("--div-pos")]],
    texttemplate: n <= 12 ? "%{z:.2f}" : "", textfont: { color: css("--ink"), size: 11 }, xgap: 2, ygap: 2,
    customdata: corr.map((row, a) => row.map((_, b) => `${names[a]} / ${names[b]}`)),
    hovertemplate: "%{customdata}<br>Korrelasjon %{z:.2f}<extra></extra>",
    colorbar: { thickness: 10, tickfont: { color: css("--axis") }, outlinewidth: 0 },
  }], layout({ margin: { l: 70, r: 8, t: 8, b: 60 }, xaxis: axis({ showgrid: false, showline: false }),
    yaxis: axis({ showgrid: false, showline: false, autorange: "reversed" }) }));

  const rc = E.riskContrib(R.w, R.S);
  plot("chart-rc", [
    { type: "bar", orientation: "h", name: "Vekt", y: order.map((k) => lab[k]), x: order.map((k) => R.w[k] * 100), marker: { color: css("--baseline") },
      hovertemplate: "%{y}: vekt %{x:.1f} %<extra></extra>" },
    { type: "bar", orientation: "h", name: "Risikobidrag", y: order.map((k) => lab[k]), x: order.map((k) => rc[k] * 100), marker: { color: css("--mine") },
      hovertemplate: "%{y}: risikobidrag %{x:.1f} %<extra></extra>" },
  ], layout({ barmode: "group", bargap: 0.3, bargroupgap: 0.1, margin: { l: 80, r: 16, t: 8, b: 40 },
    xaxis: axis({ ticksuffix: " %", rangemode: "tozero" }), yaxis: axis({ showgrid: false }) }));
}

// ---------------------------------------------------------------- backtest
function setupBacktest() {
  const B = st.bt, def = D.summary.defaults;
  const bind = (id, key, conv = (v) => v, ev = "change") => {
    const el = $(id);
    if (el.type === "checkbox") el.checked = !!B[key]; else el.value = B[key];
    el.addEventListener(ev, () => { B[key] = el.type === "checkbox" ? el.checked : conv(el.value); store.set(LS.bt, B); runBacktest(); });
  };
  bind("b-mode", "mode"); bind("b-rule", "rule"); bind("b-start", "start");
  bind("b-cost", "cost", (v) => (ok(+v) ? +v : def.trading_cost_pct), "input");
  bind("b-amount", "amount", (v) => (ok(+v) && +v > 0 ? +v : def.portfolio_value_nok), "input");
  bind("b-log", "log");
  $("b-rule").querySelector('option[value="band"]').textContent = `Ved avvik (±${num(def.rebalance_band_pp)} pp)`;
}

function runBacktest() {
  const R = st.result, B = st.bt, status = $("bt-status");
  st.btres = null;
  if (!R) { notice(status, "", "ℹ Backtesten kjøres når utvalget har fått vekter i steg 2."); renderBacktestCharts(); table($("bt-table"), [{ t: "" }], []); table($("bt-trailing"), [{ t: "" }], []); return; }
  const ser = R.series, bench = R.bench, n = ser.length;
  const common = Math.max(...ser.map((s) => E.firstIdx(s)), E.firstIdx(bench));
  const wf = B.mode !== "fixed";
  const step = B.mode === "wf3" ? 3 : 12;
  const minEst = 36;
  let auto = wf ? common + minEst : common;
  // start-year options
  const sel = $("b-start"), y0 = monthYM(Math.min(auto, D.end - 12)).y, y1 = monthYM(D.end).y - 1;
  const opts = [`<option value="auto">Tidligst mulig (${monthLabel(auto)})</option>`];
  for (let y = y0 + 1; y <= y1; y++) opts.push(`<option value="${y}">${y}</option>`);
  sel.innerHTML = opts.join("");
  sel.value = [...sel.options].some((o) => o.value === String(B.start)) ? String(B.start) : "auto";
  let start = auto;
  if (sel.value !== "auto") { for (let i = auto; i <= D.end; i++) if (monthYM(i).y === +sel.value && monthYM(i).m === 1) { start = i; break; } }
  if (D.end - start + 1 < 12) {
    notice(status, "critical", `<strong>⚠ For kort periode:</strong> ${wf ? "walk-forward trenger minst 3 års data før start" : "ETF-ene har for kort felles historikk"} – bare ${Math.max(0, D.end - start + 1)} måneder igjen.`);
    renderBacktestCharts(); table($("bt-table"), [{ t: "" }], []); table($("bt-trailing"), [{ t: "" }], []); return;
  }
  const items = R.items, obj = st.sel.objective;
  let nOpt = 0;
  const targetAt = wf
    ? (i) => {
      const W = Math.min(st.sel.window, i - common);
      const r = optimizeAt(ser, bench, i - W, i - 1, items, obj);
      nOpt++;
      return r.error ? null : r.w;
    }
    : () => R.w;
  const reoptAt = wf ? (i) => (i - start) % step === 0 : () => false;
  const band = D.summary.defaults.rebalance_band_pp / 100;
  const sim = E.simulate(ser, start, D.end, targetAt, reoptAt, B.rule, band, B.cost / 100, (i) => monthYM(i));
  const bv = E.cumulative(bench, start, D.end, 1);
  const dates = []; for (let i = start - 1; i <= D.end; i++) dates.push(monthEnd(i));
  const pr = E.pathReturns(sim.values), br = E.pathReturns(bv), rf = D.rf.slice(start, D.end + 1);
  const L = pr.length;
  const sp = E.stats(pr, br, rf, L - 1, L), sb = E.stats(br, null, rf, L - 1, L);
  st.btres = { dates, pv: sim.values, bv, pr, br, rf, sp, sb, sim, start, nOpt };
  const insample = !wf && R.from <= D.end;
  notice(status, insample ? "warning" : "", insample
    ? `<strong>⚠ In-sample:</strong> Vektene er beregnet med data fra ${monthLabel(R.from)}–${monthLabel(D.end)}, som overlapper backtesten. ` +
      "Resultatet ser derfor bedre ut enn du kunne oppnådd i virkeligheten, særlig med høy andel historikk. Velg walk-forward for en ærligere test."
    : `ℹ Walk-forward: ny optimering ${step === 12 ? "hvert år" : "hvert kvartal"} med opptil ${num(Math.min(st.sel.window, 999) / 12, 0)} års data som fantes da (${nOpt} optimeringer). ` +
      "Bare dagens ETF-er er med (survivorship bias).");
  renderBacktestTables();
  renderBacktestCharts();
}

function yearReturns(r, start) {
  const out = {};
  r.forEach((x, k) => { const { y } = monthYM(start + k); out[y] = (out[y] ?? 1) * (1 + x); });
  const months = {}; r.forEach((_, k) => { const { y } = monthYM(start + k); months[y] = (months[y] || 0) + 1; });
  return Object.keys(out).map((y) => ({ y: +y, r: out[y] - 1, full: months[y] === 12 }));
}

function renderBacktestTables() {
  const T = st.btres; if (!T) return;
  const { sp, sb, sim, pr, br } = T;
  const amt = st.bt.amount;
  const yp = yearReturns(pr, T.start), yb = yearReturns(br, T.start);
  const full = (a) => a.filter((x) => x.full);
  const best = (a) => (full(a).length ? Math.max(...full(a).map((x) => x.r)) : null), worst = (a) => (full(a).length ? Math.min(...full(a).map((x) => x.r)) : null);
  const beat = pr.filter((x, k) => x > br[k]).length / pr.length;
  const diff = (a, b, f = pp) => ({ html: ok(a) && ok(b) ? f(a - b) : "–" });
  const rows = [
    ["Annualisert avkastning", pct(sp.ret), pct(sb.ret), diff(sp.ret, sb.ret)],
    ["Volatilitet", pct(sp.vol), pct(sb.vol), diff(sp.vol, sb.vol)],
    ["Sharpe", num(sp.sharpe, 2), num(sb.sharpe, 2), diff(sp.sharpe, sb.sharpe, (x) => (x > 0 ? "+" : "") + nf(2).format(x))],
    ["Maks fall", pct(sp.mdd), pct(sb.mdd), diff(sp.mdd, sb.mdd)],
    ["Alfa (annualisert)", pct(sp.alpha), "–", ""],
    ["Beta", num(sp.beta, 2), "1,00", ""],
    ["R²", num(ok(sp.r2) ? sp.r2 * 100 : null, 0), "100", ""],
    ["Tracking error", pct(sp.te), "–", ""],
    ["Informasjonsrate", num(sp.ir, 2), "–", ""],
    ["Beste kalenderår", pct(best(yp)), pct(best(yb)), ""],
    ["Verste kalenderår", pct(worst(yp)), pct(worst(yb)), ""],
    ["Måneder bedre enn referansen", pct(beat, 0), "–", ""],
    [`Sluttverdi av ${kr(amt)}`, kr(amt * T.pv[T.pv.length - 1]), kr(amt * T.bv[T.bv.length - 1]), { html: kr(amt * (T.pv[T.pv.length - 1] - T.bv[T.bv.length - 1])) }],
    ["Handelskostnad per år", pct(sim.costsPerYear, 2), "0,00 %", ""],
    ["Omsetning per år", pct(sim.turnoverPerYear, 0), "–", ""],
  ];
  table($("bt-table"), [{ t: "" }, { t: "Utvalget", num: true }, { t: "Referanse", num: true }, { t: "Differanse", num: true }],
    rows.map((r) => ({ cells: [r[0], { html: r[1] }, { html: r[2] }, typeof r[3] === "object" ? r[3] : { html: r[3] || "" }] })));
  $("bt-table-note").textContent = `${monthLabel(T.start)}–${monthLabel(D.end)} (${num(pr.length / 12, 1)} år). Referanse: ${D.by[st.bench].ticker} ${D.by[st.bench].name}. ` +
    `Sharpe og alfa bruker historisk risikofri rente (snitt ${pct(sp.rf, 1)} per år).`;
  const tr = [];
  for (const P of PERIODS) {
    const len = 12 * P; if (len > pr.length) continue;
    const a = E.stats(pr, br, T.rf, pr.length - 1, len), b = E.stats(br, null, T.rf, br.length - 1, len);
    tr.push({ cells: [`${P} år`, { html: pct(a.ret) }, { html: pct(b.ret) }, { html: pp(a.ret - b.ret) }, { html: pct(a.vol) }, { html: pct(b.vol) },
      { html: num(a.sharpe, 2) }, { html: num(b.sharpe, 2) }, { html: pct(a.alpha) }, { html: num(a.beta, 2) }] });
  }
  table($("bt-trailing"), [{ t: "Periode" }, { t: "Utvalget", num: true }, { t: "Referanse", num: true }, { t: "Differanse", num: true },
    { t: "Vol. utvalg", num: true }, { t: "Vol. ref.", num: true }, { t: "Sharpe utvalg", num: true }, { t: "Sharpe ref.", num: true },
    { t: "Alfa", num: true }, { t: "Beta", num: true }], tr, { empty: "Backtesten er kortere enn 1 år." });
}

const yearTick = (months) => (months <= 12 * 3 ? "M6" : months <= 12 * 12 ? "M12" : "M24");
function renderBacktestCharts() {
  const T = st.btres;
  if (!T) { ["chart-bt", "chart-dd", "chart-years"].forEach((id) => emptyChart(id, "Ingen backtest ennå")); return; }
  const amt = st.bt.amount, lbl = "Utvalget", rl = "Referanse";
  const end = (arr) => arr[arr.length - 1] * amt;
  plot("chart-bt", [
    { x: T.dates, y: T.pv.map((v) => v * amt), name: lbl, mode: "lines", line: { color: css("--mine"), width: 2.5 }, hovertemplate: "%{y:,.0f} kr<extra>Utvalget</extra>" },
    { x: T.dates, y: T.bv.map((v) => v * amt), name: rl, mode: "lines", line: { color: css("--ref"), width: 2 }, hovertemplate: "%{y:,.0f} kr<extra>Referanse</extra>" },
  ], layout({ hovermode: "x unified", margin: { l: 70, r: 90, t: 32, b: 40 },
    annotations: [
      { x: T.dates[T.dates.length - 1], y: st.bt.log ? Math.log10(end(T.pv)) : end(T.pv), text: lbl, showarrow: false, xanchor: "left", xshift: 6, font: { color: css("--ink"), size: 11 } },
      { x: T.dates[T.dates.length - 1], y: st.bt.log ? Math.log10(end(T.bv)) : end(T.bv), text: rl, showarrow: false, xanchor: "left", xshift: 6, font: { color: css("--ink-2"), size: 11 } }],
    xaxis: axis({ type: "date", tickformat: T.dates.length <= 37 ? "%m.%Y" : "%Y", dtick: yearTick(T.dates.length), range: [T.dates[0], T.dates[T.dates.length - 1]] }), yaxis: axis({ titleText: "Verdi (kr)", type: st.bt.log ? "log" : "linear", tickformat: ",.0f" })
    }));
  const dp = E.drawdownSeries(T.pv), db = E.drawdownSeries(T.bv);
  plot("chart-dd", [
    { x: T.dates, y: dp.map((x) => x * 100), name: lbl, mode: "lines", line: { color: css("--mine"), width: 2 }, hovertemplate: "%{y:.1f} %<extra>Utvalget</extra>" },
    { x: T.dates, y: db.map((x) => x * 100), name: rl, mode: "lines", line: { color: css("--ref"), width: 2 }, hovertemplate: "%{y:.1f} %<extra>Referanse</extra>" },
  ], layout({ hovermode: "x unified", xaxis: axis({ type: "date", tickformat: T.dates.length <= 37 ? "%m.%Y" : "%Y", dtick: yearTick(T.dates.length), range: [T.dates[0], T.dates[T.dates.length - 1]] }),
    yaxis: axis({ ticksuffix: " %", titleText: "Fall fra toppen" }) }));
  const yp = yearReturns(T.pr, T.start), yb = yearReturns(T.br, T.start);
  const xl = yp.map((x) => (x.full ? String(x.y) : `${x.y}*`));
  plot("chart-years", [
    { type: "bar", name: lbl, x: xl, y: yp.map((x) => x.r * 100), marker: { color: css("--mine") }, hovertemplate: "%{x}: %{y:.1f} %<extra>Utvalget</extra>" },
    { type: "bar", name: rl, x: xl, y: yb.map((x) => x.r * 100), marker: { color: css("--ref") }, hovertemplate: "%{x}: %{y:.1f} %<extra>Referanse</extra>" },
  ], layout({ barmode: "group", bargap: 0.25, bargroupgap: 0.08, xaxis: axis({ type: "category", tickangle: -45 }),
    yaxis: axis({ ticksuffix: " %", titleText: "Avkastning (* = delvis år)" }) }));
}

// ---------------------------------------------------------------- rebalancing
function saveHoldings() { store.set(LS.hold, st.holdings); }
const optionText = (e) => `${e.ticker} – ${e.name} (${e.isin})`;
function findEtf(text) {
  const t = String(text || "").trim();
  const m = t.match(/\(([A-Z]{2}[A-Z0-9]{9}[0-9])\)\s*$/) || t.match(/^([A-Z]{2}[A-Z0-9]{9}[0-9])$/);
  if (m && D.by[m[1]]) return D.by[m[1]];
  const up = t.toUpperCase();
  return D.list.find((e) => String(e.ticker).toUpperCase() === up) || null;
}

function setupRebalancing() {
  $("etf-options").innerHTML = D.list.map((e) => `<option value="${esc(optionText(e))}"></option>`).join("");
  $("rebal-cash").value = st.holdings.cash || 0;
  const changed = () => { saveHoldings(); computeRebalancing(); };
  $("rebal-equiv").addEventListener("change", computeRebalancing);
  $("rebal-cash").addEventListener("input", () => { st.holdings.cash = +$("rebal-cash").value || 0; changed(); });
  $("add-holding").addEventListener("click", () => { st.holdings.items.push({ isin: "", unit: "kr", value: 0 }); renderHoldings(); changed(); });
  $("clear-holdings").addEventListener("click", () => {
    if (!confirm("Slette alle beholdninger lagret i denne nettleseren?")) return;
    st.holdings = { cash: 0, items: [] }; $("rebal-cash").value = 0; renderHoldings(); changed();
  });
  $("export-holdings").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(st.holdings, null, 1)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "beholdninger.json" });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("import-holdings").addEventListener("change", (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    f.text().then((t) => {
      const h = JSON.parse(t);
      if (!Array.isArray(h.items)) throw new Error("mangler items");
      st.holdings = { cash: +h.cash || 0, items: h.items.map((i) => ({ isin: String(i.isin || ""), unit: i.unit === "andeler" ? "andeler" : "kr", value: +i.value || 0 })) };
      $("rebal-cash").value = st.holdings.cash; renderHoldings(); changed();
    }).catch((e) => alert("Kunne ikke lese filen: " + e.message));
    ev.target.value = "";
  });
  renderHoldings();
}

function renderHoldings() {
  const box = $("holdings"), items = st.holdings.items;
  if (!items.length) { box.innerHTML = `<p class="muted">Ingen beholdninger lagt inn. Trykk «Legg til ETF».</p>`; return; }
  box.innerHTML = items.map((it, i) => {
    const e = D.by[it.isin];
    const hint = e ? `${e.ticker} · ${e.currency || ""} · kurs ${ok(e.price_nok) ? nf(2).format(e.price_nok) + " kr" : "ukjent"} (${dateNo(e.price_date)})` : (it.isin ? "Ukjent ETF" : "");
    return `<div class="holding" data-i="${i}">
      <input list="etf-options" aria-label="ETF" placeholder="Søk ticker, navn eller ISIN" value="${e ? esc(optionText(e)) : esc(it.isin)}">
      <select aria-label="Enhet"><option value="kr" ${it.unit === "kr" ? "selected" : ""}>Beløp (kr)</option><option value="andeler" ${it.unit === "andeler" ? "selected" : ""}>Andeler</option></select>
      <input type="number" inputmode="decimal" min="0" step="any" aria-label="Verdi" value="${it.value || 0}">
      <button class="btn icon" type="button" aria-label="Fjern">✕</button>
      <div class="hint">${esc(hint)}</div></div>`;
  }).join("");
  box.querySelectorAll(".holding").forEach((row) => {
    const i = +row.dataset.i;
    const [inp, sel, val] = row.querySelectorAll("input, select");
    inp.addEventListener("change", () => { const e = findEtf(inp.value); st.holdings.items[i].isin = e ? e.isin : inp.value; saveHoldings(); renderHoldings(); computeRebalancing(); });
    sel.addEventListener("change", () => { st.holdings.items[i].unit = sel.value; saveHoldings(); computeRebalancing(); });
    val.addEventListener("input", () => { st.holdings.items[i].value = +val.value || 0; saveHoldings(); computeRebalancing(); });
    row.querySelector("button").addEventListener("click", () => { st.holdings.items.splice(i, 1); saveHoldings(); renderHoldings(); computeRebalancing(); });
  });
}

function holdingNok(it) {
  const e = D.by[it.isin];
  if (!e) return 0;
  return it.unit === "andeler" ? (ok(e.price_nok) ? it.value * e.price_nok : 0) : it.value;
}

function computeRebalancing() {
  const R = st.result, status = $("rebal-status");
  if (!R) { notice(status, "", "ℹ Ombalansering bruker vektene fra steg 2. Lag et utvalg først."); table($("rebal-table"), [{ t: "" }], []); $("rebal-note").textContent = ""; return; }
  const equiv = $("rebal-equiv").checked;
  const band = D.summary.defaults.rebalance_band_pp / 100;
  const target = {}; R.isins.forEach((i, k) => { if (R.w[k] > 1e-4) target[i] = R.w[k]; });
  const targetByCluster = {}; for (const i of Object.keys(target)) targetByCluster[D.by[i].cluster] = i;
  const cash = +st.holdings.cash || 0;
  const rows = {};
  let held = 0;
  for (const it of st.holdings.items) {
    const v = holdingNok(it);
    if (!D.by[it.isin] || v <= 0) continue;
    held += v;
    let k = it.isin;
    if (!(k in target) && equiv && targetByCluster[D.by[k].cluster]) k = targetByCluster[D.by[k].cluster];
    rows[k] ||= { cur: 0, via: [] };
    rows[k].cur += v;
    if (k !== it.isin) rows[k].via.push(D.by[it.isin].ticker);
  }
  for (const i of Object.keys(target)) rows[i] ||= { cur: 0, via: [] };
  const total = held + cash;
  const out = [];
  let maxDev = 0, nOut = 0, nonTarget = 0;
  for (const [i, r] of Object.entries(rows)) {
    const e = D.by[i] || {};
    const tw = target[i] || 0, cw = total > 0 ? r.cur / total : 0, dev = cw - tw, trade = tw * total - r.cur;
    if (!(i in target)) nonTarget++;
    if (Math.abs(dev) > band) nOut++;
    maxDev = Math.max(maxDev, Math.abs(dev));
    out.push({ i, e, r, tw, cw, dev, trade, shares: ok(e.price_nok) && e.price_nok > 0 ? trade / e.price_nok : null });
  }
  out.sort((a, b) => b.tw - a.tw || b.r.cur - a.r.cur);
  const noTrade = st.holdings.items.length > 0 && cash < 1 && nOut === 0 && nonTarget === 0;
  if (!st.holdings.items.length && !cash) notice(status, "", "ℹ Legg inn beholdninger og/eller et innskudd for å få forslag til handler.");
  else if (noTrade) notice(status, "good", `<strong>✓ Ingen handel nødvendig.</strong> Alle vekter er innenfor ±${num(band * 100)} pp (største avvik ${pp(maxDev)}).`);
  else {
    const why = [];
    if (nOut) why.push(`${nOut} vekt${nOut > 1 ? "er" : ""} utenfor ±${num(band * 100)} pp`);
    if (nonTarget) why.push(`${nonTarget} ETF-er som ikke er i målporteføljen`);
    if (cash >= 1) why.push(`nytt innskudd på ${kr(cash)}`);
    notice(status, "warning", `<strong>⚠ Handel anbefales:</strong> ${why.join(", ")}. Tabellen viser handler som bringer alle vekter til målet.`);
  }
  const rowsHtml = out.map((x) => ({ cells: [
    { html: `<strong>${esc(x.e.ticker || x.i)}</strong>${x.r.via.length ? ` <span class="tag">holdes via ${esc(x.r.via.join(", "))}</span>` : ""}${!(x.i in target) ? ' <span class="tag">ikke i målet</span>' : ""}` },
    x.e.name || "", { html: kr(x.r.cur) }, { html: pct(x.cw) }, { html: pct(x.tw) },
    { html: total > 0 ? `${Math.abs(x.dev) > band ? "⚠ " : ""}${pp(x.dev)}` : "–" },
    noTrade || Math.abs(x.trade) < 1 ? { html: "–" } : { html: `${x.trade > 0 ? "Kjøp" : "Selg"} ${kr(Math.abs(x.trade))}`, cls: x.trade > 0 ? "pos" : "neg" },
    { html: !noTrade && ok(x.shares) && Math.abs(x.trade) >= 1 ? num(Math.round(Math.abs(x.shares))) : "–" },
  ] }));
  if (out.length) rowsHtml.push({ _cls: "total", cells: ["Sum", "", { html: kr(held) }, { html: pct(total ? held / total : 0) }, { html: pct(1) }, "", { html: cash ? `Innskudd ${kr(cash)}` : "" }, ""] });
  table($("rebal-table"), [{ t: "ETF" }, { t: "Navn", cls: "hide-narrow" }, { t: "Nå (kr)", num: true, cls: "hide-narrow" }, { t: "Vekt nå", num: true, cls: "hide-narrow" }, { t: "Mål", num: true },
    { t: "Avvik", num: true }, { t: "Handel", num: true }, { t: "Andeler", num: true }], rowsHtml);
  $("rebal-note").textContent = `Kurs per andel er siste sluttkurs i NOK (${dateNo(D.summary.data_until)}); antall andeler er avrundet. ` +
    "Små handler kan koste mer i minstekurtasje enn de gir. Med «likeverdige» regnes en ETF som følger samme indeks som målets ETF, så du slipper å selge den.";
}

// ---------------------------------------------------------------- tips, quality, method, changes
function renderTips() {
  $("tips-body").innerHTML = `
    <h3>Arbeidsflyt</h3>
    <ol>
      <li><strong>Finn kandidater per sektor:</strong> velg f.eks. Sektor = Teknologi, Helse og Tema = Biotek, sett «Vis: Beste i hver gruppe» og «Ranger etter: Sharpe» på 5 eller 10 år. Bytt til 3 år for å se om rekkefølgen holder seg.</li>
      <li><strong>Sjekk at det er ulike eksponeringer:</strong> «Én per indeks» skjuler kopier av samme indeks. Se på R² og korrelasjonen i steg 2: to ETF-er med korrelasjon over 0,9 gjør nesten den samme jobben.</li>
      <li><strong>Sett grenser før du optimerer:</strong> en kjerne i referansen (f.eks. 40–70 %) og satellitter på 0–15 % hver hindrer at én sektor tar over.</li>
      <li><strong>Test ærlig:</strong> bruk walk-forward i backtesten. Faste vekter optimert på samme periode ser alltid bra ut.</li>
    </ol>
    <h3>Hva nøkkeltallene sier, og hvordan de bør kombineres</h3>
    <ul>
      <li><strong>Avkastning (1/3/5/10 år):</strong> 1 år er mest støy og momentum. Se etter ETF-er som er gode på både 3, 5 og 10 år; én enkelt sterk periode er ofte flaks eller en sektorbølge (som teknologi 2015–2025).</li>
      <li><strong>Volatilitet:</strong> verdensindeksen ligger typisk på 12–15 % i NOK, sektor-ETF-er på 18–30 %. Høy volatilitet krever høyere avkastning for å være verdt det.</li>
      <li><strong>Sharpe:</strong> avkastning per enhet total risiko. Best til å sammenligne ETF-er <em>innenfor</em> samme sektor. Over 0,5 på 5–10 år er godt, under 0,2 er svakt.</li>
      <li><strong>Beta:</strong> hvor mye ETF-en følger verden. Beta 1,3 og alfa rundt 0 betyr i praksis en giret verdensindeks, ikke en ny kilde til avkastning.</li>
      <li><strong>R²:</strong> andel av svingningene verden forklarer. Høy R² (&gt; 85) = lite diversifisering. Lav R² (&lt; 60) = egne drivere, nyttig i en portefølje selv med middels Sharpe.</li>
      <li><strong>Alfa:</strong> avkastning utover det beta tilsier. Bare meningsfull når R² er rimelig høy (&gt; 70); med lav R² er alfa mest et mål på at ETF-en er annerledes. Positiv alfa på både 5 og 10 år er et sterkere signal enn høy alfa på 3 år.</li>
      <li><strong>Tracking error og informasjonsrate:</strong> TE er hvor mye ETF-en avviker fra verden; IR = meravkastning / TE. IR over 0,3–0,5 over 5+ år betyr at avviket faktisk har lønnet seg.</li>
      <li><strong>Maks fall:</strong> spør deg selv om du hadde holdt fast. Sektor-ETF-er har ofte falt 40–60 %.</li>
    </ul>
    <h3>En fornuftig rangering innenfor en sektor</h3>
    <p>Krav: minst 5 års historikk, avgift under ca. 0,5 %, størrelse over et par hundre millioner. Ranger så på Sharpe over 5 år, og sjekk at den også er god på 10 år og at alfa ikke er negativ.
      Ved likhet: velg lavest avgift, deretter størst fond. For porteføljen er lav R² mot referansen mer verdt enn en litt høyere Sharpe.</p>
    <h3>Optimeringen</h3>
    <ul>
      <li><strong>Maks Sharpe</strong> er mest følsom for forventet avkastning. Med 0 % historikk gir den bare diversifiseringsgevinst (likevekt: risikofri + beta × premie), med 100 % jager den fortidens vinnere. 20–40 % er et rimelig kompromiss.</li>
      <li><strong>Minimum varians</strong> og <strong>risikoparitet</strong> bruker ikke avkastningsestimater og er mer robuste, men gir mer vekt til lavvolatile ETF-er.</li>
      <li>Lengre estimeringsvindu (5–10 år) gir stabilere vekter. Med få felles år blir alt usikkert; «Forleng kort historikk» bruker en ETF på samme indeks for årene før.</li>
    </ul>`;
}

function renderQuality() {
  const Q = D.quality, c = Q.coverage || {}, u = Q.universe || {}, h = c.history || {};
  $("quality").innerHTML = [
    kpi("ETF-er hos Nordnet", num(D.summary.nordnet_n), `${num(c.active_isins)} unike ISIN`),
    kpi("Med kursdata", num(Q.n_with_returns), `månedsavkastning til ${dateNo(D.summary.returns_until)}`),
    kpi("Minst 5 års historikk", num(h.min_5y), `≥ 10 år: ${num(h.min_10y)}`),
    kpi("Indekser (klynger)", num(u.n_clusters), `${num(u.n_multi_member_clusters)} med flere ETF-er · TE ${pct(u.te_threshold, 2)}`),
  ].join("");
}

function renderMethod() {
  $("method").innerHTML = `
    <h3>Data</h3>
    <p>Hele ETF-listen hos Nordnet hentes månedlig. Kurser fra Yahoo Finance gjøres om til totalavkastning (utbytte reinvestert) og til NOK med Norges Banks
    valutakurser, og feilkurser renses automatisk. Nøkkeltallene bruker månedsavkastning (siste kurs i hver måned) til og med ${dateNo(D.summary.returns_until)}.
    ETF-enes løpende kostnader ligger allerede i kursen.</p>
    <h3>Nøkkeltall</h3>
    <p>Annualisert avkastning er geometrisk. Volatilitet = standardavvik av månedsavkastning × √12. Sharpe = (annualisert avkastning − risikofri rente) / volatilitet.
    Beta, alfa og R² fra regresjon av meravkastning (over risikofri) mot referansens meravkastning; alfa er annualisert som (1 + månedlig alfa)<sup>12</sup> − 1.
    Tracking error = standardavvik av månedlig differanse × √12, informasjonsrate = (avkastning − referansens) / TE. Risikofri rente: ${esc(D.summary.rf_source)}.</p>
    <h3>Sektor, tema, region og stil</h3>
    <p>Utledet fra Morningstar-kategorien hos Nordnet og fondets navn med enkle, faste regler (for eksempel «Biotech» i navnet gir tema Biotek). Det kan bli feil for enkelte fond.
    «Én per indeks» bruker klyngingen av ETF-er med tracking error under ${pct(D.summary.te_threshold, 2)} mot hverandre, og viser den billigste (eller den med lengst historikk).</p>
    <h3>Optimering</h3>
    <p>Kovarians: Ledoit-Wolf-krymping mot konstant korrelasjon, på månedsdata i valgt vindu. Forventet avkastning: blanding av likevekt
    (risikofri rente nå + beta mot referansen × risikopremie) og historisk snitt. Maks Sharpe og minimum varians løses eksakt innenfor min./maks.-grensene; risikoparitet tilpasses grensene.</p>
    <h3>Forbehold</h3>
    <ul>
      <li>Modellverktøy, ikke finansiell rådgivning. Historisk avkastning er ingen garanti for fremtidig avkastning.</li>
      <li>Bare ETF-er som finnes i dag er med (survivorship bias): nedlagte sektorfond fra tidligere år mangler, så historikken ser bedre ut enn den var.</li>
      <li>Kursdata fra Yahoo Finance er uoffisielle og kan inneholde feil.</li>
      <li>Kontotype: ${esc(D.summary.account?.type || "ASK")}. ${D.summary.account?.tax_warning ? "Utenfor ASK utløser salg gevinstskatt." : "På ASK utløser ombalansering ikke skatt før uttak."}</li>
    </ul>`;
}

function renderChanges() {
  const C = D.changes;
  $("changes-runs").innerHTML = C.runs.map((r, idx) => {
    const counts = Object.entries(r.counts).map(([k, n]) => `<span class="tag">${esc(CHANGE[k] || k)}: ${num(n)}</span>`).join(" ");
    const first = idx === C.runs.length - 1 && !r.items.length;
    const items = r.items.slice(0, 200).map((x) => `<tr><td><span class="tag">${esc(CHANGE[x.change] || x.change)}</span></td><td>${esc(x.symbol || "")}</td>
      <td>${esc(x.name || "")}</td><td>${esc(x.field || "")}</td><td>${esc(x.old ?? "")}</td><td>${esc(x.new ?? "")}</td></tr>`).join("");
    return `<div style="margin-bottom:12px"><strong>${dateNo(r.run_at)}</strong> ${counts}
      ${first ? '<p class="muted">Første kjøring: alle ETF-er registrert som nye.</p>' : items
    ? `<div class="table-scroll"><table class="data"><thead><tr><th>Endring</th><th>Ticker</th><th>Navn</th><th>Felt</th><th>Før</th><th>Etter</th></tr></thead><tbody>${items}</tbody></table></div>`
    : '<p class="muted">Ingen endringer.</p>'}</div>`;
  }).join("") || '<p class="muted">Ingen kjøringer.</p>';
}

document.addEventListener("DOMContentLoaded", init);
