/* ETF-portefølje – static site. Reads site/data/*.json; holdings live only in localStorage. */
"use strict";

const FILES = ["summary", "portfolios", "frontier", "stability", "risk", "backtest", "universe", "model", "changes", "quality"];
const PF = ["max_sharpe", "min_variance", "risk_parity", "hrp"];
const SYMBOL = { max_sharpe: "star", min_variance: "diamond", risk_parity: "square", hrp: "triangle-up", reference: "circle", current: "x" };
const TEXTPOS = { max_sharpe: "bottom right", min_variance: "bottom center", risk_parity: "middle left", hrp: "top center", reference: "top left", current: "top center" };
const RULES = { monthly: "Månedlig", quarterly: "Kvartalsvis", annual: "Årlig", band: "Ved avvik" };
const CHANGE = { new: "Ny", gone: "Utgått", reappeared: "Tilbake", changed: "Endret" };
const LS_HOLD = "etfpf.holdings.v1";
const LS_THEME = "etfpf.theme";
const D = {};
const state = { port: null, frontierPoint: null, current: null };
const redraw = [];  // chart renderers re-run on theme change

// ---------------------------------------------------------------- formatting (nb-NO)
const nfCache = {};
const nf = (d) => (nfCache[d] ||= new Intl.NumberFormat("nb-NO", { minimumFractionDigits: d, maximumFractionDigits: d }));
const ok = (x) => x !== null && x !== undefined && Number.isFinite(+x);
const pct = (x, d = 1) => (ok(x) ? nf(d).format(x * 100) + " %" : "–");
const pp = (x, d = 1) => {
  if (!ok(x)) return "–";
  const v = Math.round(x * 100 * 10 ** d) / 10 ** d;     // avoid "−0,0"
  return (v > 0 ? "+" : "") + nf(d).format(v === 0 ? 0 : v) + " pp";
};
const num = (x, d = 0) => (ok(x) ? nf(d).format(x) : "–");
const kr = (x) => (ok(x) ? nf(0).format(Math.round(x)) + " kr" : "–");
const dateNo = (s) => { if (!s) return "–"; const [y, m, d] = String(s).slice(0, 10).split("-"); return `${d}.${m}.${y}`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = (k) => css("--pf-" + k);
const $ = (id) => document.getElementById(id);
const label = (k) => (D.summary?.labels || {})[k] || k;
const swatch = (k) => `<span class="swatch" style="background:${color(k)}" aria-hidden="true"></span>`;
const nbText = (s) => String(s ?? "").replace(/(\d)\.(\d)/g, "$1,$2");   // "2.6 år" -> "2,6 år"
const accLabel = (a) => (a === 1 || a === "1" ? "Akk." : a === 0 || a === "0" ? "Utd." : "–");

function kpi(lbl, value, sub) {
  return `<div class="kpi"><div class="label">${esc(lbl)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}

function table(el, head, rows, opts = {}) {
  const th = head.map((h) => `<th class="${h.num ? "num" : ""} ${h.cls || ""}" scope="col">${esc(h.t)}</th>`).join("");
  const body = rows.map((r) => `<tr class="${r._cls || ""}">${r.cells.map((c, i) => `<td class="${head[i].num ? "num" : ""} ${head[i].cls || ""} ${c.cls || ""}">${c.html ?? esc(c)}</td>`).join("")}</tr>`).join("");
  el.innerHTML = `<thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${head.length}" class="muted">${opts.empty || "Ingen rader"}</td></tr>`}</tbody>`;
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
  const base = {
    paper_bgcolor: css("--surface"), plot_bgcolor: css("--surface"),
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: css("--ink-2"), size: 12 },
    separators: ", ", margin: { l: 56, r: 16, t: 8, b: 48 },
    hoverlabel: { bgcolor: css("--surface"), bordercolor: css("--baseline"), font: { color: css("--ink"), size: 12 } },
    legend: { orientation: "h", x: 0, y: -0.2, font: { color: css("--ink-2") } },
  };
  return Object.assign(base, o);
}
function plot(id, traces, lay) {
  const el = $(id);
  if (!el || !window.Plotly) return;
  Plotly.react(el, traces, lay, PCONF);
}

// ---------------------------------------------------------------- loading
async function load() {
  const res = await Promise.all(FILES.map((f) => fetch(`data/${f}.json`, { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(`${f}.json: HTTP ${r.status}`); return r.json(); })));
  FILES.forEach((f, i) => (D[f] = res[i]));
  D.etfByIsin = Object.fromEntries(D.universe.etfs.map((e) => [e.isin, e]));
  D.repOfCluster = {};
  D.universe.etfs.forEach((e) => { if (e.is_representative) D.repOfCluster[e.cluster_id] = e.isin; });
  D.modelIdx = Object.fromEntries(D.model.isins.map((i, k) => [i, k]));
}

function init() {
  setupTheme();
  load().then(() => {
    state.port = D.portfolios.recommended || "max_sharpe";
    renderHeader();
    renderKPIs();
    renderPortSelect();
    renderPortfolio();
    setupRebalancing();
    renderRisk();
    renderBacktest();
    renderExplorer();
    renderChanges();
    renderQuality();
    renderMethod();
    renderFrontier();
    redraw.push(renderFrontier, renderWeightsChart, renderRiskCharts, renderBacktestChart);
  }).catch((e) => {
    const el = $("load-error");
    el.hidden = false;
    el.innerHTML = `<strong>⚠ Feil:</strong> Kunne ikke laste data (${esc(e.message)}). Siden krever filene i <code>data/</code>.`;
    console.error(e);
  });
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
    try { localStorage.setItem(LS_THEME, next); } catch (e) { /* private mode */ }
    sync();
    redraw.forEach((f) => f());
    renderPortSelect();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { sync(); redraw.forEach((f) => f()); });
  sync();
}

// ---------------------------------------------------------------- 1. header + KPIs
function renderHeader() {
  const s = D.summary;
  $("updated").textContent = `Data til ${dateNo(s.data_until)} · Nordnet hentet ${dateNo(s.nordnet_run_at)} · beregnet ${dateNo(s.generated_at)}`;
  if (s.account?.tax_warning) {
    const el = $("tax-warning");
    el.hidden = false;
    el.innerHTML = "<strong>⚠ Skatt:</strong> Kontoen er ikke en aksjesparekonto (ASK). Salg ved ombalansering utløser gevinstskatt, som ikke er regnet med her.";
  }
}

function renderKPIs() {
  const s = D.summary, st = s.stats, ref = s.reference.stats;
  $("kpi-label").innerHTML = `${swatch(s.recommended)} ${esc(s.recommended_label)}`;
  $("kpis").innerHTML = [
    kpi("Forventet avkastning", pct(st.exp_return), `Referanse ${pct(ref.exp_return)}`),
    kpi("Volatilitet", pct(st.vol), `Referanse ${pct(ref.vol)}`),
    kpi("Sharpe", num(st.sharpe, 2), `Referanse ${num(ref.sharpe, 2)} · rf ${pct(s.params.risk_free_rate)}`),
    kpi("Maks fall", pct(st.max_drawdown), `Dagens vekter siden ${dateNo(st.history_from)}`),
    kpi("Årlig avgift (vektet)", pct(st.fee / 100, 2), `Referanse ${pct(ref.fee / 100, 2)}`),
    kpi("Antall ETF-er", num(st.n), `Maks ${s.params.max_assets}, ${pct(s.params.min_weight, 0)}–${pct(s.params.max_weight, 0)} hver`),
    kpi("Oppdatert", dateNo(s.data_until), `Kjørt ${dateNo(s.generated_at)}`),
  ].join("");
}

// ---------------------------------------------------------------- 2. frontier
function renderFrontier() {
  const F = D.frontier;
  const band = F.band.filter((b) => ok(b.p10) && ok(b.p90));
  const pts = F.points;
  const traces = [];
  if (band.length) {
    traces.push({ x: band.map((b) => b.vol * 100), y: band.map((b) => b.p90 * 100), mode: "lines", line: { width: 0 },
      hoverinfo: "skip", showlegend: false, name: "p90" });
    traces.push({ x: band.map((b) => b.vol * 100), y: band.map((b) => b.p10 * 100), mode: "lines", line: { width: 0 },
      fill: "tonexty", fillcolor: css("--band"), hoverinfo: "skip", name: "Bootstrap-bånd (10.–90. pst.)" });
  }
  traces.push({
    x: F.assets.map((a) => a.vol * 100), y: F.assets.map((a) => a.ret * 100), mode: "markers", name: "Representant-ETF-er",
    marker: { size: 6, color: css("--dot") },
    customdata: F.assets.map((a) => [a.name, a.ticker, a.isin, ok(a.fee) ? nf(2).format(a.fee) + " %" : "–"]),
    hovertemplate: "<b>%{customdata[0]}</b><br>%{customdata[1]} · %{customdata[2]}<br>Avgift %{customdata[3]}<br>" +
      "Volatilitet %{x:.1f} % · forventet %{y:.1f} %<extra></extra>",
  });
  traces.push({
    x: pts.map((p) => p.vol * 100), y: pts.map((p) => p.ret * 100), mode: "lines+markers", name: "Effisient frontier",
    line: { color: css("--ink-2"), width: 2 }, marker: { size: 8, color: css("--ink-2"), opacity: 0.001 },
    customdata: pts.map((p) => p.sharpe),
    hovertemplate: "Volatilitet %{x:.1f} %<br>Forventet %{y:.1f} %<br>Sharpe %{customdata:.2f}<extra>Frontier – klikk for vekter</extra>",
  });
  const markers = Object.assign({}, F.markers);
  if (state.current) markers.current = { label: label("current"), vol: state.current.vol, ret: state.current.ret };
  for (const [k, m] of Object.entries(markers)) {
    traces.push({
      x: [m.vol * 100], y: [m.ret * 100], mode: "markers+text", name: m.label, text: [m.label], textposition: TEXTPOS[k] || "top center",
      textfont: { color: css("--ink"), size: 12 },
      marker: { size: k === "current" ? 13 : 15, symbol: SYMBOL[k] || "circle", color: color(k), line: { color: css("--surface"), width: 2 } },
      hovertemplate: `<b>${esc(m.label)}</b><br>Volatilitet %{x:.1f} %<br>Forventet %{y:.1f} %<extra></extra>`,
    });
  }
  const vmax = Math.max(...pts.map((p) => p.vol), ...Object.values(markers).map((m) => m.vol)) * 100;
  const rs = [...pts.map((p) => p.ret), ...Object.values(markers).map((m) => m.ret)].map((r) => r * 100);
  plot("chart-frontier", traces, layout({
    xaxis: axis({ titleText: "Volatilitet (årlig, %)", ticksuffix: " %", range: [0, vmax * 1.45], rangemode: "tozero" }),
    yaxis: axis({ titleText: "Forventet avkastning (årlig, %)", ticksuffix: " %",
      range: [Math.min(0, Math.min(...rs) - 1), Math.max(...rs) + 2] }),
    hovermode: "closest", margin: { l: 64, r: 16, t: 8, b: 56 },
  }));
  $("boot-n").textContent = num(D.stability.samples);
  const el = $("chart-frontier");
  if (!el._clickBound && el.on) {
    el.on("plotly_click", (ev) => {
      const p = ev.points?.[0];
      if (p && p.data.name === "Effisient frontier") showFrontierPoint(p.pointIndex);
    });
    el._clickBound = true;
  }
}

function showFrontierPoint(i) {
  const p = D.frontier.points[i];
  $("frontier-point").hidden = false;
  $("frontier-point-stats").textContent = `Volatilitet ${pct(p.vol)} · forventet avkastning ${pct(p.ret)} · Sharpe ${num(p.sharpe, 2)}. ` +
    "Punkter på frontieren er uten minstevekt og maks antall ETF-er.";
  const rows = Object.entries(p.weights).sort((a, b) => b[1] - a[1]).map(([isin, w]) => {
    const e = D.etfByIsin[isin] || {};
    return { cells: [e.ticker || "", isin, e.name || "", { html: pct(w) }, e.category || ""] };
  });
  table($("frontier-point-table"), [{ t: "Ticker" }, { t: "ISIN" }, { t: "Navn" }, { t: "Vekt", num: true }, { t: "Kategori" }], rows);
  $("frontier-point").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------------------------------------------------------------- 3. portfolios
function renderPortSelect() {
  const keys = [...PF, "reference"];
  $("port-select").innerHTML = keys.map((k) => `<button type="button" role="tab" data-k="${k}" aria-selected="${k === state.port}">
    ${swatch(k)}${esc(label(k))}</button>`).join("");
  $("port-select").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    state.port = b.dataset.k;
    renderPortSelect();
    renderPortfolio();
  }));
}

function renderPortfolio() {
  const P = D.portfolios.portfolios[state.port];
  const st = P.stats;
  $("port-kpis").innerHTML = [
    kpi("Forventet avkastning", pct(st.exp_return)), kpi("Volatilitet", pct(st.vol)), kpi("Sharpe", num(st.sharpe, 2)),
    kpi("Maks fall", pct(st.max_drawdown)), kpi("Årlig avgift", pct(st.fee / 100, 2)), kpi("Antall ETF-er", num(st.n)),
  ].join("");
  renderWeightsChart();
  const rows = P.holdings.map((h) => ({ cells: [
    { html: `<strong>${esc(h.ticker)}</strong>` }, h.isin, { html: esc(h.name), cls: "wide" }, { html: pct(h.weight) },
    { html: ok(h.fee) ? nf(2).format(h.fee) + " %" : "–" }, h.currency || "–", h.category || "–", accLabel(h.accumulating),
    { html: h.nordnet_url ? `<a href="${esc(h.nordnet_url)}" target="_blank" rel="noopener">Nordnet ↗</a>` : "–" },
  ] }));
  table($("port-table"), [{ t: "Ticker" }, { t: "ISIN", cls: "hide-narrow" }, { t: "Navn" }, { t: "Vekt", num: true }, { t: "Avgift", num: true },
    { t: "Valuta" }, { t: "Kategori" }, { t: "Akk./utd." }, { t: "Lenke" }], rows);
  renderStability();
}

function renderWeightsChart() {
  const P = D.portfolios.portfolios[state.port];
  const h = [...P.holdings].reverse();
  $("chart-weights").style.height = `${Math.max(180, 34 * h.length + 70)}px`;
  plot("chart-weights", [{
    type: "bar", orientation: "h", x: h.map((x) => x.weight * 100), y: h.map((x) => x.ticker),
    marker: { color: color(state.port) }, customdata: h.map((x) => x.name),
    hovertemplate: "<b>%{customdata}</b><br>Vekt %{x:.1f} %<extra></extra>", name: P.label,
  }], layout({
    showlegend: false, bargap: 0.35, margin: { l: 90, r: 16, t: 8, b: 40 },
    xaxis: axis({ ticksuffix: " %", rangemode: "tozero", titleText: "Vekt" }), yaxis: axis({ showgrid: false }),
  }));
}

function renderStability() {
  const S = D.stability;
  const rows = S.portfolios[state.port];
  $("stability-note").textContent = rows
    ? `${S.note} ${num(S.samples)} trekk med ${S.block_weeks} ukers blokker. «Andel» = andel trekk der ETF-en får minst ${pct(D.summary.params.min_weight, 0)}.`
    : "Bootstrap er beregnet for maks Sharpe og minimum varians.";
  table($("stability-table"), [{ t: "Ticker" }, { t: "Navn" }, { t: "Modellvekt", num: true }, { t: "Snitt", num: true },
    { t: "10.–90. persentil", num: true }, { t: "Andel", num: true }],
  (rows || []).slice(0, 25).map((r) => ({ cells: [r.ticker, r.name, { html: pct(r.model_weight) }, { html: pct(r.mean) },
    { html: `${pct(r.p10)} – ${pct(r.p90)}` }, { html: pct(r.freq, 0) }] })), { empty: "Ikke beregnet for denne porteføljen." });
}

// ---------------------------------------------------------------- 4. rebalancing
function loadHoldings() {
  try { return JSON.parse(localStorage.getItem(LS_HOLD)) || { cash: 0, items: [] }; } catch (e) { return { cash: 0, items: [] }; }
}
function saveHoldings(h) {
  try { localStorage.setItem(LS_HOLD, JSON.stringify(h)); } catch (e) { /* storage unavailable: keep in memory */ }
}
const optionText = (e) => `${e.ticker} – ${e.name} (${e.isin})`;
function findEtf(text) {
  const t = String(text || "").trim();
  const m = t.match(/\(([A-Z]{2}[A-Z0-9]{9}\d)\)\s*$/) || t.match(/^([A-Z]{2}[A-Z0-9]{9}\d)$/i);
  if (m) return D.etfByIsin[m[1].toUpperCase()];
  const up = t.toUpperCase();
  return D.universe.etfs.find((e) => (e.ticker || "").toUpperCase() === up);
}

function setupRebalancing() {
  const H = loadHoldings();
  state.holdings = H;
  $("etf-options").innerHTML = D.universe.etfs.map((e) => `<option value="${esc(optionText(e))}"></option>`).join("");
  $("rebal-target").innerHTML = PF.map((k) => `<option value="${k}" ${k === D.portfolios.recommended ? "selected" : ""}>${esc(label(k))}</option>`).join("");
  $("rebal-cash").value = H.cash || 0;
  const changed = () => { saveHoldings(state.holdings); computeRebalancing(); };
  $("rebal-target").addEventListener("change", computeRebalancing);
  $("rebal-equiv").addEventListener("change", computeRebalancing);
  $("rebal-cash").addEventListener("input", () => { state.holdings.cash = +$("rebal-cash").value || 0; changed(); });
  $("add-holding").addEventListener("click", () => { state.holdings.items.push({ isin: "", unit: "kr", value: 0 }); renderHoldings(); changed(); });
  $("clear-holdings").addEventListener("click", () => {
    if (!confirm("Slette alle beholdninger lagret i denne nettleseren?")) return;
    state.holdings = { cash: 0, items: [] }; $("rebal-cash").value = 0; renderHoldings(); changed();
  });
  $("export-holdings").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.holdings, null, 1)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "beholdninger.json" });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("import-holdings").addEventListener("change", (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    f.text().then((t) => {
      const h = JSON.parse(t);
      if (!Array.isArray(h.items)) throw new Error("mangler items");
      state.holdings = { cash: +h.cash || 0, items: h.items.map((i) => ({ isin: String(i.isin || ""), unit: i.unit === "andeler" ? "andeler" : "kr", value: +i.value || 0 })) };
      $("rebal-cash").value = state.holdings.cash; renderHoldings(); changed();
    }).catch((e) => alert("Kunne ikke lese filen: " + e.message));
    ev.target.value = "";
  });
  renderHoldings();
  computeRebalancing();
}

function renderHoldings() {
  const box = $("holdings");
  const items = state.holdings.items;
  if (!items.length) { box.innerHTML = `<p class="muted">Ingen beholdninger lagt inn. Trykk «Legg til ETF».</p>`; return; }
  box.innerHTML = items.map((it, i) => {
    const e = D.etfByIsin[it.isin];
    const hint = e ? `${e.ticker} · ${e.currency || ""} · kurs ${ok(e.price_nok) ? nf(2).format(e.price_nok) + " kr" : "ukjent"} (${dateNo(e.price_date)})` +
      (e.is_representative ? "" : D.repOfCluster[e.cluster_id] ? ` · regnes som ${D.etfByIsin[D.repOfCluster[e.cluster_id]].ticker} i modellen` : " · ikke med i modellen") : (it.isin ? "Ukjent ETF" : "");
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
    inp.addEventListener("change", () => { const e = findEtf(inp.value); state.holdings.items[i].isin = e ? e.isin : inp.value; saveHoldings(state.holdings); renderHoldings(); computeRebalancing(); });
    sel.addEventListener("change", () => { state.holdings.items[i].unit = sel.value; saveHoldings(state.holdings); computeRebalancing(); });
    val.addEventListener("input", () => { state.holdings.items[i].value = +val.value || 0; saveHoldings(state.holdings); computeRebalancing(); });
    row.querySelector("button").addEventListener("click", () => { state.holdings.items.splice(i, 1); saveHoldings(state.holdings); renderHoldings(); computeRebalancing(); });
  });
}

function holdingNok(it) {
  const e = D.etfByIsin[it.isin];
  if (!e) return 0;
  return it.unit === "andeler" ? (ok(e.price_nok) ? it.value * e.price_nok : 0) : it.value;
}

function computeRebalancing() {
  const key = $("rebal-target").value;
  const equiv = $("rebal-equiv").checked;
  const band = (D.summary.params.rebalance_band_pp || 5) / 100;
  const target = Object.fromEntries(D.portfolios.portfolios[key].holdings.map((h) => [h.isin, h.weight]));
  const targetByCluster = {};
  for (const i of Object.keys(target)) targetByCluster[D.etfByIsin[i]?.cluster_id] = i;
  const cash = +state.holdings.cash || 0;
  const rows = {};      // isin -> {cur, via: []}
  let held = 0;
  for (const it of state.holdings.items) {
    const v = holdingNok(it);
    if (!D.etfByIsin[it.isin] || v <= 0) continue;
    held += v;
    let k = it.isin;
    if (!(k in target) && equiv && targetByCluster[D.etfByIsin[k].cluster_id]) k = targetByCluster[D.etfByIsin[k].cluster_id];
    rows[k] ||= { cur: 0, via: [] };
    rows[k].cur += v;
    if (k !== it.isin) rows[k].via.push(D.etfByIsin[it.isin].ticker);
  }
  for (const i of Object.keys(target)) rows[i] ||= { cur: 0, via: [] };
  const total = held + cash;
  const out = [];
  let maxDev = 0, nOut = 0, nonTarget = 0;
  for (const [i, r] of Object.entries(rows)) {
    const e = D.etfByIsin[i] || {};
    const tw = target[i] || 0;
    const cw = total > 0 ? r.cur / total : 0;
    const dev = cw - tw;
    const trade = tw * total - r.cur;
    if (!(i in target)) nonTarget++;
    if (Math.abs(dev) > band) nOut++;
    maxDev = Math.max(maxDev, Math.abs(dev));
    out.push({ i, e, r, tw, cw, dev, trade, shares: ok(e.price_nok) && e.price_nok > 0 ? trade / e.price_nok : null });
  }
  out.sort((a, b) => b.tw - a.tw || b.r.cur - a.r.cur);
  const noTrade = state.holdings.items.length > 0 && cash < 1 && nOut === 0 && nonTarget === 0;
  const status = $("rebal-status");
  status.hidden = false;
  if (!state.holdings.items.length && !cash) {
    status.className = "notice";
    status.innerHTML = "ℹ Legg inn beholdninger og/eller et innskudd for å få forslag til handler.";
  } else if (noTrade) {
    status.className = "notice good";
    status.innerHTML = `<strong>✓ Ingen handel nødvendig.</strong> Alle vekter er innenfor ±${num(band * 100)} pp (største avvik ${pp(maxDev)}).`;
  } else {
    status.className = "notice warning";
    const why = [];
    if (nOut) why.push(`${nOut} vekt${nOut > 1 ? "er" : ""} utenfor ±${num(band * 100)} pp`);
    if (nonTarget) why.push(`${nonTarget} ETF-er som ikke er i målporteføljen`);
    if (cash >= 1) why.push(`nytt innskudd på ${kr(cash)}`);
    status.innerHTML = `<strong>⚠ Handel anbefales:</strong> ${why.join(", ")}. Tabellen viser handler som bringer alle vekter til målet.`;
  }
  const rowsHtml = out.map((x) => ({ _cls: Math.abs(x.dev) > band ? "outside" : "", cells: [
    { html: `<strong>${esc(x.e.ticker || x.i)}</strong>${x.r.via.length ? ` <span class="tag">holdes via ${esc(x.r.via.join(", "))}</span>` : ""}${!(x.i in target) ? ' <span class="tag">ikke i målet</span>' : ""}` },
    x.e.name || "", { html: kr(x.r.cur) }, { html: pct(x.cw) }, { html: pct(x.tw) },
    { html: `${Math.abs(x.dev) > band ? "⚠ " : ""}${pp(x.dev)}` },
    noTrade || Math.abs(x.trade) < 1 ? { html: "–" }
      : { html: `${x.trade > 0 ? "Kjøp" : "Selg"} ${kr(Math.abs(x.trade))}`, cls: x.trade > 0 ? "pos" : "neg" },
    { html: !noTrade && ok(x.shares) && Math.abs(x.trade) >= 1 ? num(Math.round(Math.abs(x.shares))) : "–" },
  ] }));
  if (out.length) rowsHtml.push({ _cls: "total", cells: ["Sum", "", { html: kr(held) }, { html: pct(total ? held / total : 0) }, { html: pct(1) }, "", { html: cash ? `Innskudd ${kr(cash)}` : "" }, ""] });
  table($("rebal-table"), [{ t: "ETF" }, { t: "Navn", cls: "hide-narrow" }, { t: "Nå (kr)", num: true, cls: "hide-narrow" }, { t: "Vekt nå", num: true, cls: "hide-narrow" }, { t: "Mål", num: true },
    { t: "Avvik", num: true }, { t: "Handel", num: true }, { t: "Andeler", num: true }], rowsHtml);
  $("rebal-note").textContent = `Kurs per andel er siste sluttkurs i NOK (${dateNo(D.summary.data_until)}); antall andeler er avrundet. ` +
    "Små handler kan koste mer i minstekurtasje enn de gir. Med «likeverdige» regnes en ETF i samme klynge (TE under terskelen) som målets ETF, så du slipper å selge den.";
  updateCurrent();
}

function updateCurrent() {
  // Map holdings to model representatives (same cluster) and compute expected return / volatility.
  const M = D.model;
  const w = new Map();
  let tot = 0;
  for (const it of state.holdings.items) {
    const v = holdingNok(it);
    const e = D.etfByIsin[it.isin];
    if (!e || v <= 0) continue;
    const rep = it.isin in D.modelIdx ? it.isin : D.repOfCluster[e.cluster_id];
    if (!(rep in D.modelIdx)) continue;
    w.set(D.modelIdx[rep], (w.get(D.modelIdx[rep]) || 0) + v);
    tot += v;
  }
  if (!tot) { state.current = null; renderFrontier(); return; }
  const idx = [...w.keys()], ws = idx.map((k) => w.get(k) / tot);
  const cov = (a, b) => (a >= b ? M.cov_lower[a][b] : M.cov_lower[b][a]);
  let ret = 0, v = 0;
  idx.forEach((a, x) => { ret += ws[x] * M.mu[a]; idx.forEach((b, y) => { v += ws[x] * ws[y] * cov(a, b); }); });
  state.current = { ret, vol: Math.sqrt(Math.max(v, 0)) };
  renderFrontier();
}

// ---------------------------------------------------------------- 5. risk
function renderRisk() { renderRiskCharts(); }
function renderRiskCharts() {
  const R = D.risk;
  const names = R.isins.map((i) => D.etfByIsin[i]?.name || i);
  plot("chart-corr", [{
    type: "heatmap", z: R.corr, x: R.labels, y: R.labels, zmin: -1, zmax: 1,
    colorscale: [[0, css("--div-neg")], [0.5, css("--div-mid")], [1, css("--div-pos")]],
    texttemplate: "%{z:.2f}", textfont: { color: css("--ink"), size: 11 }, xgap: 2, ygap: 2,
    customdata: R.corr.map((row, a) => row.map((_, b) => `${names[a]} / ${names[b]}`)),
    hovertemplate: "%{customdata}<br>Korrelasjon %{z:.2f}<extra></extra>",
    colorbar: { thickness: 10, tickfont: { color: css("--axis") }, outlinewidth: 0 },
  }], layout({ margin: { l: 70, r: 8, t: 8, b: 60 }, xaxis: axis({ showgrid: false, showline: false }),
    yaxis: axis({ showgrid: false, showline: false, autorange: "reversed" }) }));
  const lbl = [...R.labels].reverse(), wt = [...R.weights].reverse(), rc = [...R.risk_contribution].reverse();
  plot("chart-rc", [
    { type: "bar", orientation: "h", name: "Vekt", y: lbl, x: wt.map((x) => x * 100), marker: { color: css("--baseline") },
      hovertemplate: "%{y}: vekt %{x:.1f} %<extra></extra>" },
    { type: "bar", orientation: "h", name: "Risikobidrag", y: lbl, x: rc.map((x) => x * 100), marker: { color: color(R.portfolio) },
      hovertemplate: "%{y}: risikobidrag %{x:.1f} %<extra></extra>" },
  ], layout({ barmode: "group", bargap: 0.3, bargroupgap: 0.1, margin: { l: 80, r: 16, t: 8, b: 40 },
    xaxis: axis({ ticksuffix: " %", rangemode: "tozero" }), yaxis: axis({ showgrid: false }) }));
  const dd = R.drawdown;
  plot("chart-dd", [
    { x: dd.dates, y: dd.portfolio.map((x) => x * 100), name: label(R.portfolio), mode: "lines", line: { color: color(R.portfolio), width: 2 },
      hovertemplate: "%{x|%d.%m.%Y}: %{y:.1f} %<extra>" + esc(label(R.portfolio)) + "</extra>" },
    { x: dd.dates, y: dd.reference.map((x) => (ok(x) ? x * 100 : null)), name: label("reference"), mode: "lines", line: { color: color("reference"), width: 2 },
      hovertemplate: "%{x|%d.%m.%Y}: %{y:.1f} %<extra>" + esc(label("reference")) + "</extra>" },
  ], layout({ hovermode: "x unified", xaxis: axis({ type: "date", tickformat: "%Y" }),
    yaxis: axis({ ticksuffix: " %", titleText: "Fall fra toppen" }) }));
}

// ---------------------------------------------------------------- 6. backtest
function renderBacktest() {
  const B = D.backtest;
  $("bt-note").textContent = `${B.note} Ombalansering i grafen: ${RULES[B.rule_main] || B.rule_main}` +
    (B.rule_main === "band" ? ` (±${num(B.costs.rebalance_band_pp)} pp)` : "") + ". Verdier etter kurtasje, valutaveksling og spread.";
  renderBacktestChart();
  const keys = [...PF, "reference"];
  const T = Object.fromEntries(B.table.map((t) => [t.strategy, t]));
  table($("bt-table"), [{ t: "Portefølje" }, { t: "CAGR", num: true }, { t: "Volatilitet", num: true }, { t: "Sharpe", num: true },
    { t: "Maks fall", num: true }, { t: "Kostnad/år", num: true }],
  keys.filter((k) => T[k]).map((k) => ({ cells: [{ html: `${swatch(k)} ${esc(label(k))}` }, { html: pct(T[k].cagr) }, { html: pct(T[k].vol) },
    { html: num(T[k].sharpe, 2) }, { html: pct(T[k].max_drawdown) }, { html: k === "reference" ? "–" : pct(T[k].costs_pct_per_year / 100, 2) }] })));
  const best = Math.max(...B.frequency.map((f) => f.cagr));
  table($("freq-table"), [{ t: "Regel" }, { t: "CAGR", num: true }, { t: "Kostnad/år", num: true }, { t: "Handler/år", num: true }, { t: "Omsetning/år", num: true }],
    B.frequency.map((f) => ({ cells: [
      { html: `${esc(RULES[f.rule] || f.rule)}${f.rule === "band" ? ` (±${num(B.costs.rebalance_band_pp)} pp)` : ""}${f.cagr === best ? ' <span class="tag">best</span>' : ""}` },
      { html: pct(f.cagr) }, { html: pct(f.costs_pct_per_year / 100, 2) }, { html: num(f.trades_per_year, 1) }, { html: pct(f.turnover_per_year, 0) }] })));
  const c = B.costs;
  $("cost-note").textContent = `Forutsetninger: porteføljeverdi ${kr(c.portfolio_value_nok)}, kurtasje ${pct(c.courtage_pct, 2)} (minst ${kr(c.courtage_min_nok)}), ` +
    `valutaveksling ${pct(c.fx_fee_pct, 2)}, halv spread fra Nordnet (ellers ${pct(c.default_spread_pct / 100, 2)}).`;
}

function renderBacktestChart() {
  const B = D.backtest;
  const keys = [...PF, "reference"].filter((k) => B.series[k]);
  plot("chart-bt", keys.map((k) => ({
    x: B.dates, y: B.series[k], name: label(k), mode: "lines", connectgaps: true,
    line: { color: color(k), width: k === B.recommended || k === "reference" ? 2.5 : 1.5 },
    hovertemplate: "%{y:.2f}<extra>" + esc(label(k)) + "</extra>",
  })), layout({ hovermode: "x unified", xaxis: axis({ type: "date", tickformat: "%Y" }),
    yaxis: axis({ titleText: "Verdi av 1 kr (etter kostnader)", type: "log", tickformat: ".1f" }) }));
}

// ---------------------------------------------------------------- 7. explorer
function renderExplorer() {
  if (!window.Tabulator) { $("explorer").innerHTML = '<p class="muted">Tabellbiblioteket kunne ikke lastes.</p>'; return; }
  const pctF = (d) => (cell) => pct(cell.getValue(), d);
  const numF = (d) => (cell) => num(cell.getValue(), d);
  const sorterNull = (a, b) => (ok(a) ? +a : -Infinity) - (ok(b) ? +b : -Infinity);
  const t = new Tabulator("#explorer", {
    data: D.universe.etfs, index: "isin", layout: "fitData", height: "620px", pagination: true, paginationSize: 50,
    paginationCounter: (size, cur, page, total) => `${num(total)} ETF-er`, renderVertical: "basic", placeholder: "Ingen treff",
    langs: { nb: { pagination: { first: "Første", first_title: "Første side", last: "Siste", last_title: "Siste side",
      prev: "Forrige", prev_title: "Forrige side", next: "Neste", next_title: "Neste side", page_size: "Rader" } } }, locale: "nb",
    initialSort: [{ column: "is_representative", dir: "desc" }],
    columns: [
      { title: "Ticker", field: "ticker", frozen: true, formatter: (c) => `<strong>${esc(c.getValue())}</strong>` },
      { title: "Navn", field: "name", width: 280, formatter: (c) => esc(c.getValue()), tooltip: true },
      { title: "ISIN", field: "isin" },
      { title: "Kategori", field: "category", width: 170, tooltip: true },
      { title: "Valuta", field: "currency" },
      { title: "Avgift", field: "fee", hozAlign: "right", cssClass: "num", sorter: sorterNull, formatter: (c) => (ok(c.getValue()) ? nf(2).format(c.getValue()) + " %" : "–") },
      { title: "Historikk", field: "history_years", hozAlign: "right", cssClass: "num", sorter: sorterNull, formatter: (c) => (ok(c.getValue()) ? nf(1).format(c.getValue()) + " år" : "–") },
      { title: "CAGR", field: "cagr", hozAlign: "right", cssClass: "num", sorter: sorterNull, formatter: pctF(1) },
      { title: "Volatilitet", field: "vol", hozAlign: "right", cssClass: "num", sorter: sorterNull, formatter: pctF(1) },
      { title: "Sharpe", field: "sharpe", hozAlign: "right", cssClass: "num", sorter: sorterNull, formatter: numF(2) },
      { title: "Maks fall", field: "max_drawdown", hozAlign: "right", cssClass: "num", sorter: sorterNull, formatter: pctF(0) },
      { title: "Eiere", field: "owners", hozAlign: "right", cssClass: "num", sorter: sorterNull, formatter: numF(0) },
      { title: "Utsteder", field: "issuer" },
      { title: "Akk./utd.", field: "accumulating", formatter: (c) => accLabel(c.getValue()) },
      { title: "Klynge", field: "cluster_id", hozAlign: "right", cssClass: "num", formatter: (c) => {
        const r = c.getRow().getData(); return `${r.cluster_id}${r.cluster_size > 1 ? ` <span class="tag">${r.cluster_size}</span>` : ""}`; } },
      { title: "Rep.", field: "is_representative", hozAlign: "center", formatter: (c) => (c.getValue() ? "✓ ja" : "") },
      { title: "Status", field: "reason", width: 220, tooltip: true, formatter: (c) => esc(nbText(c.getValue())) },
    ],
  });
  const apply = () => {
    const q = $("exp-search").value.trim().toLowerCase();
    const f = $("exp-filter").value;
    t.setFilter((d) => {
      if (f === "rep" && !d.is_representative) return false;
      if (f === "eligible" && !d.eligible) return false;
      if (f === "multi" && !(d.cluster_size > 1)) return false;
      return !q || [d.name, d.ticker, d.isin].some((v) => String(v || "").toLowerCase().includes(q));
    });
  };
  $("exp-search").addEventListener("input", apply);
  $("exp-filter").addEventListener("change", apply);
  t.on("dataFiltered", (filters, rows) => { $("exp-count").textContent = `${num(rows.length)} treff`; });
  t.on("rowClick", (e, row) => {
    if (e.target.closest("a")) return;
    const el = row.getElement();
    const open = el.querySelector(".alt-box");
    if (open) { open.remove(); row.normalizeHeight(); return; }
    const d = row.getData();
    const alts = D.universe.etfs.filter((x) => x.cluster_id === d.cluster_id && x.isin !== d.isin);
    const box = document.createElement("div");
    box.className = "alt-box";
    box.innerHTML = alts.length
      ? `<strong>Alternativer i klynge ${d.cluster_id}</strong> (største parvise TE ${pct(D.universe.etfs.find((x) => x.isin === d.isin)?.max_te_in_cluster, 2)})
         <table class="data"><thead><tr><th>Ticker</th><th>Navn</th><th class="num">Avgift</th><th>Akk./utd.</th><th class="num">Historikk</th><th>Status</th></tr></thead><tbody>
         ${alts.map((x) => `<tr><td>${esc(x.ticker)}${x.is_representative ? ' <span class="tag">rep.</span>' : ""}</td><td>${esc(x.name)}</td>
           <td class="num">${ok(x.fee) ? nf(2).format(x.fee) + " %" : "–"}</td><td>${accLabel(x.accumulating)}</td><td class="num">${num(x.history_years, 1)} år</td><td>${esc(nbText(x.reason))}</td></tr>`).join("")}
         </tbody></table>`
      : `<span class="muted">Ingen andre ETF-er i samme klynge (ingen med tracking error under terskelen).</span>`;
    box.querySelector("table")?.style.setProperty("max-width", "900px");
    el.appendChild(box);
    row.normalizeHeight();
  });
}

// ---------------------------------------------------------------- 8. changes
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
  const W = C.weight_changes;
  if (!C.weights_previous_build) {
    $("changes-weights").innerHTML = '<p class="muted">Første beregning – ingen tidligere vekter å sammenligne med.</p>';
    return;
  }
  $("changes-weights").innerHTML = `<p class="muted">Sammenlignet med beregningen ${dateNo(C.weights_previous_build)}.</p>` + PF.map((k) => {
    const rows = W[k] || [];
    return `<h3>${swatch(k)} ${esc(label(k))}</h3>` + (rows.length
      ? `<div class="table-scroll"><table class="data"><thead><tr><th>Ticker</th><th>Navn</th><th class="num">Før</th><th class="num">Nå</th><th class="num">Endring</th></tr></thead><tbody>
        ${rows.map((x) => `<tr><td>${esc(x.ticker)}</td><td>${esc(x.name)}</td><td class="num">${pct(x.old)}</td><td class="num">${pct(x.new)}</td><td class="num">${pp(x.new - x.old)}</td></tr>`).join("")}
        </tbody></table></div>` : '<p class="muted">Uendret.</p>');
  }).join("");
}

// ---------------------------------------------------------------- 9. quality
function renderQuality() {
  const Q = D.quality, c = Q.coverage || {}, u = Q.universe || {}, cl = c.cleaning || {}, h = c.history || {};
  $("quality").innerHTML = [
    kpi("ETF-er hos Nordnet", num(D.summary.nordnet_n), `${num(c.active_isins)} unike ISIN`),
    kpi("Med ticker-mapping", num(c.mapped_isins), pct(c.mapped_isins / c.active_isins, 0)),
    kpi("Med prisdata", num(c.with_prices), `siste kurs ${dateNo(c.last_price_date)}`),
    kpi("Minst 5 års historikk", num(h.min_5y), `≥ 10 år: ${num(h.min_10y)}`),
    kpi("Klynger", num(u.n_clusters), `${num(u.n_multi_member_clusters)} med flere ETF-er · TE ${pct(u.te_threshold, 2)}`),
    kpi("Kvalifiserte", num(u.n_eligible), "handlebar, ≥ 5 år, ikke giret, ASK"),
    kpi("Representanter", num(u.n_representatives), `${num(Q.n_optimized)} i optimeringen`),
    kpi("Rensede kurser", num(cl.removed_points), `${num(cl.isins_with_removed_points)} ETF-er; ${num(cl.isins_trimmed)} med kuttet historikk`),
  ].join("");
}

// ---------------------------------------------------------------- 10. method
function renderMethod() {
  const p = D.summary.params, u = D.quality.universe || {};
  $("method").innerHTML = `
    <h3>Univers</h3>
    <p>Hele ETF-listen hos Nordnet hentes månedlig. Hver ETF får en Yahoo-ticker (Nordnet-symbol og børs, Yahoos søk og OpenFIGI),
    og totalavkastning beregnes fra sluttkurs og utbytte, omregnet til NOK med Norges Banks valutakurser. Feilkurser renses automatisk.</p>
    <h3>Automatisk reduksjon</h3>
    <p>ETF-er som følger samme indeks samles i klynger med tracking error (TE) under ${pct(u.te_threshold, 2)} (månedlig avkastning i NOK siste fem år,
    robust mot enkeltfeil, complete linkage). I hver klynge velges én representant: handlebar, minst fem års historikk, ikke giret,
    lavest avgift (utdelende regnes som 0,10 pp dyrere på ASK), deretter størst fond. Navn brukes bare som kontroll.</p>
    <h3>Optimering</h3>
    <p>Kovarians: Ledoit-Wolf-krymping av ukentlig avkastning siste ${num(p.lookback_weeks)} uker. Forventet avkastning: risikofri rente
    (${pct(p.risk_free_rate)}) + beta mot referansen × risikopremie, altså en likevektsprior uten egne synspunkter
    (vekt på historisk snitt: ${pct(p.history_weight, 0)}). Historiske snitt gir store estimeringsfeil; i en walk-forward-test jaget de
    forrige periodes vinnere og ga lavere avkastning. Begrensninger: ingen short, ${pct(p.min_weight, 0)}–${pct(p.max_weight, 0)} per ETF,
    maks ${p.max_assets} ETF-er, maks ${pct(p.max_category_weight, 0)} per kategori${p.max_portfolio_fee ? `, vektet avgift maks ${nf(2).format(p.max_portfolio_fee)} %` : ""}.
    Risikoparitet og HRP trenger ikke avkastningsestimater. Målvektene byttes bare når den nye løsningen er tydelig bedre (hysterese).</p>
    <h3>Usikkerhet og backtest</h3>
    <p>Bootstrap med blokker av uker viser hvor mye frontieren og vektene flytter seg. Backtesten er walk-forward: vekter beregnes kvartalsvis
    bare med data som fantes da, og handler belastes kurtasje, valutaveksling og spread. Universet er dagens ETF-er (survivorship bias).</p>
    <h3>Forbehold</h3>
    <ul>
      <li>Dette er et modellverktøy, ikke finansiell rådgivning. Historisk avkastning er ingen garanti for fremtidig avkastning.</li>
      <li>Kursdata fra Yahoo Finance er uoffisielle og kan inneholde feil. ETF-er uten data faller ut av optimeringen.</li>
      <li>Forventet avkastning og volatilitet er modellestimater med stor usikkerhet.</li>
      <li>Kontotype: ${esc(D.summary.account?.type || "ASK")}. ${D.summary.account?.tax_warning ? "Utenfor ASK utløser salg gevinstskatt." : "På ASK utløser ombalansering ikke skatt før uttak."}</li>
    </ul>`;
}

document.addEventListener("DOMContentLoaded", init);
