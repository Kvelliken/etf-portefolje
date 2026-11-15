/* Fond- og ETF-portefølje – static site, shared helpers and the ETF explorer.
 * The portfolio builder is in portefolje.js, the fund explorer in fond.js, calculations in engine.js and insight.js.
 * Portfolio, filters and settings live only in localStorage. */
"use strict";

const E = window.Engine;
const FILES = ["summary", "etfs", "returns", "changes", "quality"];
const PERIODS = [1, 3, 5, 10];
const LS = { theme: "etfpf.theme", filters: "etfpf.filters.v2", bench: "etfpf.benchmark.v2" };
const DD = [["asset_class", "Aktivaklasse"], ["sector", "Sektor"], ["theme", "Tema"], ["region", "Region"], ["style", "Stil"], ["issuer", "Utsteder"]];
const NONE = "(ingen)";
const CHANGE = { new: "Ny", gone: "Utgått", reappeared: "Tilbake", changed: "Endret" };

const D = {};
const st = {
  period: 5, chartTab: "scatter", bench: null,
  f: null,
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

// ---------------------------------------------------------------- Sharpe backdrop for risk/return charts
/** Background for a risk/return chart: red (poor return for the risk) to green (good), by Sharpe =
 *  (return - risk-free) / volatility. Axes in percent. Returns {traces, xr, yr, annotations}. */
function sharpeBackdrop(xs, ys, rfPct) {
  const fx = xs.filter(ok), fy = ys.filter(ok);
  const xMax = Math.max(4, ...fx) * 1.08;
  let yLo = Math.min(0, rfPct, ...fy), yHi = Math.max(rfPct + 2, ...fy);
  const pad = (yHi - yLo) * 0.08; yLo -= pad; yHi += pad;
  const N = 70, gx = [], gy = [], z = [];
  for (let i = 0; i < N; i++) { gx.push(xMax * (i + 0.5) / N); gy.push(yLo + (yHi - yLo) * (i + 0.5) / N); }
  for (const y of gy) z.push(gx.map((x) => Math.max(-0.5, Math.min(1.5, (y - rfPct) / x))));
  const dark = css("color-scheme") === "dark" || getComputedStyle(document.documentElement).colorScheme === "dark";
  const heat = {
    type: "heatmap", x: gx, y: gy, z, zmin: -0.5, zmax: 1.5, zsmooth: "best", hoverinfo: "skip", opacity: dark ? 0.5 : 0.55,
    colorscale: [[0, "#c9302c"], [0.25, "#e8743b"], [0.5, "#f2d04a"], [0.75, "#8fca5c"], [1, "#2e9e4f"]],
    colorbar: { title: { text: "Sharpe", font: { size: 11, color: css("--ink-2") } }, thickness: 10, len: 0.7, outlinewidth: 0,
      tickvals: [-0.5, 0, 0.5, 1, 1.5], ticktext: ["under −0,5", "0", "0,5", "1", "over 1,5"], tickfont: { size: 10, color: css("--axis") } },
  };
  // iso-lines so the reading does not depend on colour alone
  const lines = [0, 0.5, 1].map((sh) => {
    const xe = sh > 0 ? Math.min(xMax, (yHi - rfPct) / sh) : xMax;
    return { type: "scatter", mode: "lines", x: [0, xe], y: [rfPct, rfPct + sh * xe], hoverinfo: "skip", showlegend: false,
      line: { color: css("--ink-2"), width: 1, dash: "dot" }, opacity: 0.55 };
  });
  const annotations = [0, 0.5, 1].map((sh) => {
    const xe = (sh > 0 ? Math.min(xMax, (yHi - rfPct) / sh) : xMax) * 0.97;
    return { x: xe, y: rfPct + sh * xe, text: `Sharpe ${nf(1).format(sh)}`, showarrow: false, xanchor: "right", yanchor: "bottom",
      font: { size: 10, color: css("--ink-2") } };
  });
  return { traces: [heat, ...lines], xr: [0, xMax], yr: [yLo, yHi], annotations };
}
const SHARPE_HINT = "Bakgrunnen viser avkastning i forhold til risiko (Sharpe): grønt er mye avkastning for svingningene, rødt er lite.";

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
    renderHeader();
    setupBenchmark();
    computeMetrics();
    setupFilters();
    setupExplorer();
    renderTips();
    renderQuality();
    renderMethod();
    renderChanges();
    refreshAll();
    redraw.push(renderExplorerChart);
    D.ready = true;
  }).catch((e) => {
    notice($("load-error"), "critical", `<strong>⚠ Feil:</strong> Kunne ikke laste data (${esc(e.message)}). Siden krever filene i <code>data/</code>.`);
    console.error(e);
  });
}

function refreshAll() {
  refreshExplorer();
  if (typeof PF !== "undefined" && PF.ready) PF.refresh();
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
  if (s.account?.tax_warning) notice($("tax-warning"), "warning", "<strong>⚠ Skatt:</strong> Kontoen er ikke en aksjesparekonto (ASK). Salg og bytte av fond utløser gevinstskatt, som ikke er regnet med her.");
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
      formatter: (c) => `<button type="button" class="add-btn ${c.getValue() ? "on" : ""}" aria-label="${c.getValue() ? "Fjern fra" : "Legg til i"} porteføljen">${c.getValue() ? "✓" : "+"}</button>`,
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
  $("exp-chart-note").textContent = `${num(pts.length)} ETF-er med ${P} års historikk. Klikk på en prikk for å legge den i porteføljen. ${SHARPE_HINT}`;
  if (!pts.length) return emptyChart("chart-explorer", "Ingen ETF-er med nok historikk for perioden");
  const mk = (arr) => ({
    x: arr.map((e) => e.m[P].vol * 100), y: arr.map((e) => e.m[P].ret * 100), customdata: arr.map((e) => e.isin),
    text: arr.map((e) => `<b>${esc(e.ticker)}</b> ${esc(e.name)}<br>${esc(e.sector)}${e.theme ? " · " + esc(e.theme) : ""} · ${esc(e.region)}<br>` +
      `Avkastning ${pct(e.m[P].ret)} · vol. ${pct(e.m[P].vol)} · Sharpe ${num(e.m[P].sharpe, 2)}<br>Alfa ${pct(e.m[P].alpha)} · beta ${num(e.m[P].beta, 2)} · R² ${num(ok(e.m[P].r2) ? e.m[P].r2 * 100 : null, 0)}`),
    hovertemplate: "%{text}<extra></extra>",
  });
  const others = pts.filter((e) => !mine.has(e.isin) && e.isin !== st.bench), mineP = pts.filter((e) => mine.has(e.isin));
  const rfP = (bm?.rf ?? pts[0].m[P].rf ?? D.summary.rf_now) * 100;
  const bg = sharpeBackdrop(pts.map((e) => e.m[P].vol * 100), pts.map((e) => e.m[P].ret * 100), rfP);
  const traces = [...bg.traces,
    { ...mk(others), type: "scatter", mode: "markers", name: "ETF-er i filteret", marker: { color: css("--ink"), opacity: 0.55, size: 7, line: { color: css("--surface"), width: 1 } } },
    { ...mk(mineP), type: "scatter", mode: "markers+text", name: "I porteføljen", textposition: "top center", texttemplate: mineP.map((e) => esc(e.ticker)),
      textfont: { color: css("--ink"), size: 11 }, marker: { color: css("--mine"), size: 12, symbol: "diamond", line: { color: css("--surface"), width: 2 } } },
  ];
  if (bm) traces.push({ type: "scatter", mode: "markers+text", name: "Referanse", x: [bm.vol * 100], y: [bm.ret * 100], customdata: [st.bench],
    text: [`<b>Referanse</b> ${esc(D.by[st.bench].name)}<br>Avkastning ${pct(bm.ret)} · vol. ${pct(bm.vol)} · Sharpe ${num(bm.sharpe, 2)}`],
    texttemplate: ["Referanse"], textposition: "bottom right", textfont: { color: css("--ink"), size: 11 }, hovertemplate: "%{text}<extra></extra>",
    marker: { color: css("--surface"), size: 13, symbol: "circle", line: { color: css("--ink"), width: 2.5 } } });
  plot("chart-explorer", traces, layout({
    hovermode: "closest", annotations: bg.annotations,
    xaxis: axis({ ticksuffix: " %", titleText: `Svingninger (volatilitet) per år, ${P} år`, range: bg.xr, showgrid: false }),
    yaxis: axis({ ticksuffix: " %", titleText: `Avkastning per år, ${P} år`, range: bg.yr, showgrid: false }),
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

// ---------------------------------------------------------------- portfolio membership (state lives in portefolje.js)
function mineSet() { return typeof PF !== "undefined" && PF.ids ? PF.ids() : new Set(); }

function toggleSelect(isin) { if (typeof PF !== "undefined") PF.toggle(isin); }

/** Called by portefolje.js when the portfolio's members change. */
function onPortfolioMembers() {
  const mine = mineSet();
  if (st.table) for (const row of st.table.getRows()) { const d = row.getData(); if (d.mine !== mine.has(d.isin)) row.update({ mine: mine.has(d.isin) }); }
  if (st.f) refreshExplorer();
}

// ---------------------------------------------------------------- series + estimation
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

// ---------------------------------------------------------------- tips, quality, method, changes
function renderTips() {
  $("tips-body").innerHTML = `
    <ul>
      <li><strong>Avkastning (1/3/5/10 år):</strong> ett år er mest tilfeldigheter. Se etter ETF-er som har gjort det godt over både 3, 5 og 10 år.</li>
      <li><strong>Volatilitet:</strong> hvor mye verdien svinger. Verdensindeksen ligger typisk på 12–15 % i kroner, sektor-ETF-er på 18–30 %.</li>
      <li><strong>Sharpe:</strong> avkastning per svingning – det bakgrunnsfargen i grafen viser. Over 0,5 på 5–10 år er godt, under 0,2 er svakt.</li>
      <li><strong>Beta og R²:</strong> hvor tett ETF-en følger verdensindeksen. Høy R² (over 85) betyr at den tilfører lite nytt i en portefølje som allerede har et globalt indeksfond.</li>
      <li><strong>Alfa:</strong> avkastning utover det beta tilsier. Bare meningsfull når R² er rimelig høy.</li>
      <li><strong>Maks fall:</strong> det største fallet fra en topp. Spør deg selv om du hadde holdt fast.</li>
    </ul>
    <p>Legg kandidatene i porteføljen med +, og se under <a href="#pf-bygg">Min portefølje</a> hva de gjør med innhold, kostnad og risiko.</p>`;
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
    <h3>Forbehold</h3>
    <ul>
      <li>Modellverktøy, ikke finansiell rådgivning. Historisk avkastning er ingen garanti for fremtidig avkastning.</li>
      <li>Bare ETF-er som finnes i dag er med (survivorship bias): nedlagte sektorfond fra tidligere år mangler, så historikken ser bedre ut enn den var.</li>
      <li>Kursdata fra Yahoo Finance er uoffisielle og kan inneholde feil.</li>
      <li>Kontotype: ${esc(D.summary.account?.type || "ASK")}. ${D.summary.account?.tax_warning ? "Utenfor ASK utløser salg gevinstskatt." : "På ASK utløser bytte av fond ikke skatt før uttak."}</li>
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
