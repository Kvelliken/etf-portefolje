/* Fond- og ETF-portefølje – static site, shared helpers and the ETF explorer.
 * The portfolio builder is in portefolje.js, the fund explorer in fond.js, calculations in engine.js and insight.js.
 * Portfolio, filters and settings live only in localStorage. */
"use strict";

const E = window.Engine;
const FILES = ["summary", "etfs", "returns", "changes", "quality"];
const PERIODS = [1, 3, 5, 10];
const LS = { filters: "etfpf.filters.v2", bench: "etfpf.benchmark.v2" };
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
const pct = (x, d = 1) => (ok(x) ? nf(d).format(x * 100) + "\u00a0%" : "–");
const pp = (x, d = 1) => {
  if (!ok(x)) return "–";
  const v = Math.round(x * 100 * 10 ** d) / 10 ** d;
  return (v > 0 ? "+" : "") + nf(d).format(v === 0 ? 0 : v) + "\u00a0p.p.";
};
const num = (x, d = 0) => (ok(x) ? nf(d).format(x) : "–");
const kr = (x) => (ok(x) ? nf(0).format(Math.round(x)) + "\u00a0kr" : "–");
const MONTH_NAMES = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
/** "2026-11-02" -> "2. november 2026" */
const dateNo = (s) => { if (!s) return "–"; const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return `${d}. ${MONTH_NAMES[m - 1]} ${y}`; };
/** Write out ISO dates inside a text from the data files ("… (til 2026-10-30)" -> "… (til 30. oktober 2026)"). */
const datesInText = (t) => String(t ?? "").replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (d) => dateNo(d));
const isoDate = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
/** First working day of the month after `iso` (same rule as monthly.yml: the 1st if Mon–Fri, else the Monday after),
 *  moved on a month at a time until it is not in the past. */
function nextUpdate(iso) {
  const today = isoDate(new Date());
  let [y, m] = String(iso).slice(0, 10).split("-").map(Number);
  for (;;) {
    if (++m > 12) { m = 1; y++; }
    const d = new Date(y, m - 1, 1), wd = d.getDay();         // 0 = Sunday
    if (wd === 6) d.setDate(3); else if (wd === 0) d.setDate(2);
    if (isoDate(d) >= today) return isoDate(d);
  }
}
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
  return `<div class="vv-kpi"><span class="vv-kpi__label">${esc(lbl)}</span><span class="vv-kpi__value">${value}</span>${sub ? `<span class="vv-kpi__meta">${sub}</span>` : ""}</div>`;
}
function table(el, head, rows, opts = {}) {
  const th = head.map((h) => `<th scope="col" class="${h.num ? "vv-num" : ""} ${h.cls || ""}"${h.title ? ` title="${esc(h.title)}"` : ""}>${esc(h.t)}</th>`).join("");
  const body = rows.map((r) => `<tr class="${r._cls || ""}">${r.cells.map((c, i) => {
    const v = c?.html ?? esc(c);
    return i === 0 && !opts.plain ? `<th scope="row">${v}</th>` : `<td class="${head[i].num ? "vv-num" : ""} ${head[i].cls || ""} ${c?.cls || ""}" data-label="${esc(head[i].t)}">${v}</td>`;
  }).join("")}</tr>`).join("");
  el.innerHTML = `${opts.caption ? `<caption class="visually-hidden">${esc(opts.caption)}</caption>` : ""}<thead><tr>${th}</tr></thead><tbody>${body || `<tr><td colspan="${head.length}" class="muted">${opts.empty || "Ingen rader"}</td></tr>`}</tbody>`;
}
function notice(el, kind, html) {
  if (!html) { el.hidden = true; return; }
  el.hidden = false; el.className = "notice" + (kind ? " " + kind : ""); el.innerHTML = html;
}

// ---------------------------------------------------------------- Plotly theme (all colours from the tokens)
const PCONF = { displayModeBar: false, responsive: true };
const FONT = 'Inter, system-ui, sans-serif';
function axis(o = {}) {
  return Object.assign({
    gridcolor: css("--line-200"), linecolor: css("--line-400"), zerolinecolor: css("--line-400"), showline: true, showgrid: true,
    tickfont: { family: FONT, color: css("--ink-500"), size: 12 }, automargin: true, ticks: "", fixedrange: true,
    title: { text: o.titleText || "", font: { family: FONT, color: css("--ink-500"), size: 12 } },
  }, o);
}
function layout(o = {}) {
  const l = Object.assign({
    paper_bgcolor: css("--bg-000"), plot_bgcolor: css("--bg-000"),
    font: { family: FONT, color: css("--ink-700"), size: 12 },
    separators: ", ", margin: { l: 56, r: 16, t: 24, b: 48 },
    hoverlabel: { bgcolor: css("--bg-000"), bordercolor: css("--line-200"), font: { family: FONT, color: css("--ink-900"), size: 13 }, align: "left" },
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { family: FONT, color: css("--ink-700"), size: 12 } },
  }, o);
  // only horizontal grid lines
  if (l.xaxis && l.xaxis.showgrid === undefined) l.xaxis.showgrid = false;
  return l;
}
function plot(id, traces, lay) {
  const el = $(id);
  if (!el || !window.Plotly) return;
  Plotly.react(el, traces, lay, PCONF);
}
function emptyChart(id, text) {
  plot(id, [], layout({ xaxis: { visible: false }, yaxis: { visible: false },
    annotations: [{ text, showarrow: false, font: { family: FONT, color: css("--ink-500"), size: 14 }, xref: "paper", yref: "paper", x: 0.5, y: 0.5 }] }));
}
/** Text colour that is readable on a filled token colour. */
const INK_ON = { "--chart-1": "--bg-000", "--chart-2": "--ink-900", "--chart-3": "--bg-000", "--chart-4": "--ink-900", "--chart-context": "--ink-900",
  "--chart-focus": "--bg-000", "--seq-3": "--bg-000", "--seq-4": "--bg-000", "--seq-5": "--bg-000", "--div-pos-2": "--bg-000", "--div-neg-2": "--bg-000" };
const inkOn = (token) => css(INK_ON[token] || "--ink-900");

// ---------------------------------------------------------------- return for the risk (Sharpe) in plain words
/** Five steps from "svært dårlig" to "svært bra", by Sharpe = (return − risk-free) / volatility. */
const SHARPE_SCALE = [
  { lo: -Infinity, hi: 0, word: "Svært dårlig", color: "--div-neg-2" },
  { lo: 0, hi: 0.25, word: "Dårlig", color: "--div-neg-1" },
  { lo: 0.25, hi: 0.5, word: "Middels", color: "--div-mid" },
  { lo: 0.5, hi: 1, word: "Bra", color: "--div-pos-1" },
  { lo: 1, hi: Infinity, word: "Svært bra", color: "--div-pos-2" },
];
const sharpeStep = (s) => (ok(s) ? SHARPE_SCALE.find((z) => s < z.hi) || SHARPE_SCALE[4] : null);
const sharpeWord = (s) => (ok(s) ? sharpeStep(s).word.toLowerCase() : "–");
const SHARPE_HINT = 'De skrå linjene deler kartet etter avkastning for risikoen, fra svært dårlig til svært bra (se <a href="#ord-sharpe">Sharpe i ordlisten</a>).';

/** Thin lines between the five steps, with the step names written in the chart. Axes in percent.
 *  Returns {traces, annotations, xr, yr}. No coloured background. */
function sharpeLines(xs, ys, rfPct) {
  const fx = xs.filter(ok), fy = ys.filter(ok);
  const xMax = Math.max(4, ...fx) * 1.08;
  let yLo = Math.min(0, rfPct, ...fy), yHi = Math.max(rfPct + 2, ...fy);
  const pad = (yHi - yLo) * 0.08; yLo -= pad; yHi += pad;
  const ray = (sh) => { const xe = sh > 0 ? Math.min(xMax, (yHi - rfPct) / sh) : sh < 0 ? Math.min(xMax, (yLo - rfPct) / sh) : xMax; return xe; };
  const traces = [0, 0.25, 0.5, 1].map((sh) => ({ type: "scatter", mode: "lines", x: [0, ray(sh)], y: [rfPct, rfPct + sh * ray(sh)], hoverinfo: "skip",
    showlegend: false, line: { color: css("--line-400"), width: 1 } }));
  // names in the middle of each step, as far out as the plot allows
  const mids = [-0.35, 0.125, 0.375, 0.75, 1.6];
  const annotations = SHARPE_SCALE.map((z, i) => {
    const sh = mids[i], xe = ray(sh) * 0.9, y = rfPct + sh * xe;
    if (!(xe > xMax * 0.08) || y < yLo || y > yHi) return null;
    return { x: xe, y, text: z.word, showarrow: false, xanchor: "center", yanchor: "middle", font: { family: FONT, size: 12, color: css("--ink-500") } };
  }).filter(Boolean);
  return { traces, annotations, xr: [0, xMax], yr: [yLo, yHi] };
}

/** Points for the explorers: coloured by step (no background), the portfolio's own as white rings with their names.
 *  pts = [{x, y, s (Sharpe), id, text (hover), mine, label}] */
function stepTraces(pts) {
  const tr = (name, g, marker, extra = {}) => ({ type: "scatter", mode: "markers", name, x: g.map((p) => p.x), y: g.map((p) => p.y),
    customdata: g.map((p) => p.id), text: g.map((p) => p.text), hovertemplate: "%{text}<extra></extra>", marker, ...extra });
  const out = [];
  for (const z of SHARPE_SCALE) {
    const g = pts.filter((p) => !p.mine && sharpeStep(p.s) === z);
    if (g.length) out.push(tr(z.word, g, { color: css(z.color), size: 8, line: { color: css("--line-400"), width: 0.75 } }));
  }
  const none = pts.filter((p) => !p.mine && !sharpeStep(p.s));
  if (none.length) out.push(tr("Uten risikotall", none, { color: css("--chart-context"), size: 7, line: { width: 0 } }));
  const mine = pts.filter((p) => p.mine);
  if (mine.length) out.push(tr("I porteføljen", mine, { color: css("--bg-000"), size: 14, line: { color: css("--chart-focus"), width: 3 } },
    { mode: window.innerWidth < 640 ? "markers" : "markers+text", texttemplate: mine.map((p) => esc(p.label || "")), textposition: "top center", textfont: { family: FONT, color: css("--ink-900"), size: 12 } }));
  return out;
}
const stepLegend = () => ({ orientation: "h", x: 0, y: 1.02, yanchor: "bottom",
  title: { text: "Avkastning for risikoen:", side: window.innerWidth < 760 ? "top left" : "left", font: { family: FONT, color: css("--ink-500"), size: 12 } } });

// ---------------------------------------------------------------- figure cards (vv-figure)
const ICON = {
  table: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1"></rect><path d="M3 9h18M3 14.5h18M9 9v11"></path></svg>',
  chart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16M7 16V10M12 16V6M17 16v-4"></path></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"></path></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M8 12.5l3 3 5-6"></path></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v6M12 7.5v.5"></path></svg>',
  insight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z"></path></svg>',
};
const FIG = {};
/** Build the skeleton of every <figure class="vv-figure" data-chart="…"> once. The chart element keeps its id. */
function initFigures(root = document) {
  root.querySelectorAll("figure.vv-figure[data-fig]:not([data-ready])").forEach((f) => {
    const id = f.id, chart = f.dataset.chart, kind = f.dataset.kind || "chart", tools = f.querySelector(".fig-tools");
    const body = chart
      ? `<div id="${chart}" class="chart ${f.dataset.size ? "chart-" + f.dataset.size : ""}" role="img" aria-label=""></div>`
      : `<div class="fig-html" role="img" aria-label=""></div>`;
    f.innerHTML = `<h3 class="vv-figure__title"></h3><p class="vv-figure__subtitle"></p>
      <div class="vv-figure__body">${body}<div class="fig-table vv-table-wrap" hidden></div></div>
      <p class="vv-figure__takeaway" hidden></p><p class="vv-figure__source"></p>
      <div class="vv-figure__footer">
        <details class="vv-details fig-about"><summary>Om dataene</summary><dl></dl></details>
        <ul class="vv-downloads"><li><button type="button" class="vv-download fig-btn" data-act="table" aria-pressed="false">${ICON.table}<span>Vis som tabell</span></button></li>
          <li><button type="button" class="vv-download fig-btn" data-act="csv">${ICON.download}<span>Last ned CSV</span></button></li></ul>
      </div>`;
    if (tools) f.querySelector(".vv-figure__subtitle").after(tools);
    f.dataset.ready = "1";
    f.dataset.kind = kind;
    f.addEventListener("click", (ev) => {
      const b = ev.target.closest(".fig-btn"); if (!b) return;
      const d = FIG[id]; if (!d) return;
      if (b.dataset.act === "csv") return downloadCsv(d);
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.innerHTML = on ? `${ICON.chart}<span>Vis som figur</span>` : `${ICON.table}<span>Vis som tabell</span>`;
      f.querySelector(".fig-table").hidden = !on;
      const vis = f.querySelector(".vv-figure__body > :first-child"); vis.hidden = on;
      if (on) renderFigTable(f, d); else window.dispatchEvent(new Event("resize"));
    });
  });
}
/** Fill a figure card. o = {title, subtitle, takeaway, source, about: [[dt, dd]], aria, data: {name, head: [..], rows: [[..]]}, html} */
function figure(id, o) {
  const f = $(id); if (!f) return;
  FIG[id] = o;
  const set = (sel, html) => { const el = f.querySelector(sel); el.innerHTML = html || ""; el.hidden = !html; };
  set(".vv-figure__title", o.title); set(".vv-figure__subtitle", o.subtitle); set(".vv-figure__takeaway", o.takeaway);
  set(".vv-figure__source", o.source ? `Kilde: ${o.source}` : "");
  const about = o.about || [];
  f.querySelector(".fig-about").hidden = !about.length;
  f.querySelector(".fig-about dl").innerHTML = about.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  const vis = f.querySelector(".vv-figure__body > :first-child");
  vis.setAttribute("aria-label", o.aria || "");
  if (o.html !== undefined && f.querySelector(".fig-html")) f.querySelector(".fig-html").innerHTML = o.html;
  f.querySelector(".vv-downloads").hidden = !o.data;
  if (f.querySelector('.fig-btn[data-act="table"]').getAttribute("aria-pressed") === "true") renderFigTable(f, o);
}
function renderFigTable(f, o) {
  const d = o.data; if (!d) return;
  const num = d.num || d.head.map((_, i) => i > 0);
  f.querySelector(".fig-table").innerHTML = `<table class="vv-table"><caption class="visually-hidden">${esc(stripTags(o.title || ""))}</caption>
    <thead><tr>${d.head.map((h, i) => `<th scope="col" class="${num[i] ? "vv-num" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${d.rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(cellText(c))}</th>` : `<td class="${num[i] ? "vv-num" : ""}">${esc(cellText(c))}</td>`)).join("")}</tr>`).join("")}</tbody></table>`;
}
const stripTags = (s) => String(s).replace(/<[^>]+>/g, "");
/** Table cells may be numbers (shown with the formatter in d.fmt) or text. */
function cellText(c) { return c === null || c === undefined || (typeof c === "number" && !Number.isFinite(c)) ? "–" : typeof c === "object" ? c.t : String(c); }
function downloadCsv(o) {
  const d = o.data, q = (v) => { const s = String(v ?? ""); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const raw = (c) => (c && typeof c === "object" ? c.v ?? c.t : c);
  // semicolon and decimal comma, as Norwegian Excel expects
  const val = (c) => { const v = raw(c); return typeof v === "number" && Number.isFinite(v) ? String(v).replace(".", ",") : v; };
  const csv = "﻿" + [d.head, ...d.rows.map((r) => r.map(val))].map((r) => r.map(q).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `${d.name || "data"}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/** Cell with a number for CSV and formatted text for the table. */
const cell = (v, t) => ({ v: ok(v) ? Math.round(v * 1e6) / 1e6 : null, t });

// ---------------------------------------------------------------- filter dropdowns (shared by Finn fond and Finn ETF-er)
/** Multi-select dropdowns built on <details class="dd">. defs = [[key, label]]; keys in `mainKeys` go in mainEl, the rest in moreEl.
 *  Returns sync(), which writes the current choice into each summary. */
function setupDropdowns(card, list, defs, mainKeys, mainEl, moreEl, F, onChange) {
  for (const [k, label] of defs) (mainKeys.includes(k) ? mainEl : moreEl).insertAdjacentHTML("beforeend",
    `<details class="dd" data-k="${k}"><summary><span class="dd-label">${esc(label)}:</span> <span class="dd-val">alle</span></summary><div class="dd-panel" role="group" aria-label="${esc(label)}"></div></details>`);
  const all = () => card.querySelectorAll(".dd");
  const sync = () => all().forEach((dd) => {
    const v = F.dd[dd.dataset.k] || [];
    dd.querySelector(".dd-val").textContent = !v.length ? "alle" : v.length === 1 ? v[0] : `${v.length} valgt`;
    dd.classList.toggle("active", v.length > 0);
  });
  all().forEach((dd) => {
    const k = dd.dataset.k, counts = {};
    for (const e of list) { const v = e[k] ?? NONE; counts[v] = (counts[v] || 0) + 1; }
    const opts = Object.entries(counts).sort((a, b) => (a[0] === NONE) - (b[0] === NONE) || b[1] - a[1] || a[0].localeCompare(b[0], "nb"));
    const panel = dd.querySelector(".dd-panel");
    panel.innerHTML = `<div class="dd-actions"><button type="button" data-a="all">Vis alle (fjern valg)</button></div>` +
      opts.map(([v, n]) => `<label><input type="checkbox" value="${esc(v)}" ${F.dd[k]?.includes(v) ? "checked" : ""}> ${esc(v)} <span class="n">${num(n)}</span></label>`).join("");
    dd.addEventListener("toggle", () => { if (dd.open) all().forEach((o) => { if (o !== dd) o.open = false; }); });
    panel.addEventListener("change", () => { F.dd[k] = [...panel.querySelectorAll("input:checked")].map((i) => i.value); sync(); onChange(); });
    panel.querySelector(".dd-actions").addEventListener("click", (ev) => {
      if (!ev.target.dataset.a) return;
      panel.querySelectorAll("input").forEach((i) => { i.checked = false; });
      F.dd[k] = []; sync(); onChange();
    });
    dd.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && dd.open) { dd.open = false; dd.querySelector("summary").focus(); } });
  });
  document.addEventListener("click", (ev) => { if (!ev.target.closest(".dd")) all().forEach((o) => { o.open = false; }); });
  sync();
  return sync;
}
/** A vv-toggle (buttons with aria-pressed): marks the pressed one and calls fn(button). */
function bindToggle(el, fn) {
  el.addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b || !el.contains(b)) return;
    el.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    fn(b);
  });
}
/** Short receipt at the bottom of the screen (also read by screen readers). */
function toast(html) {
  const t = $("toast"); if (!t) return;
  t.innerHTML = html; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 4500);
}
/** The add button in the explorers' tables. */
const addBtn = (on, name) => `<button type="button" class="add-btn ${on ? "on" : ""}" aria-pressed="${on}" aria-label="${on ? "Fjern" : "Legg til"} ${esc(name)} ${on ? "fra" : "i"} porteføljen">${on ? ICON.check + "<span>I porteføljen</span>" : "<span>+ Legg til</span>"}</button>`;

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
  initFigures();
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

// ---------------------------------------------------------------- header + benchmark
function renderHeader() {
  const s = D.summary;
  const meta = [["Kurser til", s.data_until], ["Nøkkeltall per", s.returns_until], ["Nordnet hentet", s.nordnet_run_at], ["Neste oppdatering", nextUpdate(s.data_until)]];
  const html = meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${dateNo(v)}</dd></div>`).join("");
  document.querySelectorAll("[data-meta]").forEach((el) => { el.innerHTML = html; });
  const last = D.changes?.runs?.[0];
  $("footer-updated").textContent = `Sist oppdatert ${dateNo(s.data_until)}${last ? `. Siste endring i Nordnet-listen ${dateNo(last.run_at)}` : ""}. Neste oppdatering ${dateNo(nextUpdate(s.data_until))}.`;
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
  sel.innerHTML = benchmarkCandidates().map((e) => `<option value="${e.isin}">${esc(e.ticker)} – ${esc(e.name)} (${num(e.history_years, 0)} år, ${nf(2).format(e.fee)}\u00a0%)</option>`).join("");
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
    Risikofri rente: ${esc(datesInText(s.rf_source))}, nå ${pct(s.rf_now, 2)}.`;
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
    pick: true, ask: true, lev: true, mine: false, top: 0, group: "sector", rank: "sharpe", period: 5, cols: "simple" };
}
function saveFilters() { store.set(LS.filters, { ...st.f, period: st.period }); }

function setupFilters() {
  const F = st.f;
  st.syncDD = setupDropdowns($("filters"), D.list, DD, ["sector", "region"], $("dd-row-main"), $("dd-row"), F, () => onFilter());
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
  $("f-reset").addEventListener("click", () => { store.set(LS.filters, { ...defaultFilters(), cols: F.cols }); location.hash = "#etf"; location.reload(); });
  renderPeriodTabs();
  bindToggle($("exp-chart-tabs"), (b) => { st.chartTab = b.dataset.v; renderExplorerChart(); });
  const cols = $("f-cols");
  cols.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.c === (F.cols || "simple") ? "true" : "false"));
  bindToggle(cols, (b) => { F.cols = b.dataset.c; saveFilters(); st.table && st.table.setColumns(explorerColumns()); });
}

function renderPeriodTabs() {
  const el = $("f-period");
  el.innerHTML = PERIODS.map((P) => `<button type="button" data-p="${P}" aria-pressed="${P === st.period}">${P} år</button>`).join("");
  bindToggle(el, (b) => { st.period = +b.dataset.p; st.table && st.table.setColumns(explorerColumns()); onFilter(); });
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
  const pctCol = (title, field, d = 1, tip) => ({ title, field, hozAlign: "right", cssClass: "num", sorter: sorterNull, headerTooltip: tip, formatter: (c) => pct(c.getValue(), d) });
  const numCol = (title, field, d = 2, tip, mult = 1) => ({ title, field, hozAlign: "right", cssClass: "num", sorter: sorterNull, headerTooltip: tip,
    formatter: (c) => num(ok(c.getValue()) ? c.getValue() * mult : null, d) });
  const txt = (title, field, width) => ({ title, field, width, formatter: (c) => esc(c.getValue() ?? "–"), tooltip: true });
  const P = st.period, wide = window.innerWidth >= 700;
  const add = { title: "", field: "mine", frozen: wide, headerSort: false, width: 136, cssClass: "add-cell",
    formatter: (c) => addBtn(!!c.getValue(), c.getRow().getData().name),
    cellClick: (ev, c) => { if (!ev.target.closest("button")) return; ev.stopPropagation(); toggleSelect(c.getRow().getData().isin); } };
  const fee = { title: "Kostnad per år", field: "fee", hozAlign: "right", cssClass: "num", sorter: sorterNull, headerTooltip: "Årlig kostnad (TER), i prosent",
    formatter: (c) => (ok(c.getValue()) ? nf(2).format(c.getValue()) + "\u00a0%" : "–") };
  if ((st.f?.cols || "simple") === "simple") return [
    add,
    { title: "ETF", field: "name", frozen: wide, width: wide ? 300 : 200, tooltip: true,
      formatter: (c) => `<span class="cell-name">${esc(c.getValue())}</span><span class="cell-sub">${esc(c.getRow().getData().ticker)}</span>` },
    txt("Sektor", "sector", 130), txt("Region", "region", 110), fee,
    pctCol(`Avkastning per år, ${P} år`, P === 1 ? "r1" : P === 3 ? "r3" : P === 5 ? "r5" : "r10", 1, "Annualisert totalavkastning i kroner"),
    pctCol(`Svingninger, ${P} år`, "vol", 1, "Volatilitet: hvor mye verdien svinger i løpet av et år"),
    { title: "Avkastning for risikoen", field: "sharpe", sorter: sorterNull, headerTooltip: "Sharpe: avkastning utover risikofri rente delt på svingningene",
      formatter: (c) => (ok(c.getValue()) ? `${sharpeWord(c.getValue())} <span class="cell-sub-inline">(${num(c.getValue(), 2)})</span>` : "–") },
  ];
  return [
    add,
    { title: "Ticker", field: "ticker", frozen: wide, formatter: (c) => `<strong>${esc(c.getValue())}</strong>` },
    txt("Navn", "name", 250), txt("Sektor", "sector", 130), txt("Tema", "theme", 130), txt("Region", "region", 100), fee,
    numCol("Størrelse (mill.)", "size", 0, "Fondsstørrelse i millioner (fondets valuta, fra Nordnet)"),
    numCol("Historikk (år)", "history_years", 1, "Lengde på renset kurshistorikk"),
    { title: "Avkastning per år", columns: [pctCol("1 år", "r1"), pctCol("3 år", "r3"), pctCol("5 år", "r5"), pctCol("10 år", "r10")] },
    { title: `Risiko og mot referansen, ${P} år`, columns: [
      pctCol("Svingninger", "vol", 1, "Volatilitet: årlig standardavvik av månedsavkastningen"),
      numCol("Sharpe", "sharpe", 2, "(Avkastning − risikofri rente) / volatilitet"),
      pctCol("Alfa", "alpha", 1, "Jensens alfa mot referansen, annualisert: avkastning utover det beta forklarer"),
      numCol("Beta", "beta", 2, "Følsomhet for referansen: 1,2 = svinger 20 % mer enn verdensindeksen"),
      numCol("R²", "r2", 0, "Andel av svingningene som forklares av referansen (0–100). Lav R² = sprer risikoen", 100),
      pctCol("TE", "te", 1, "Tracking error: årlig standardavvik av differansen mot referansen"),
      numCol("IR", "ir", 2, "Informasjonsrate: meravkastning mot referansen / tracking error"),
      pctCol("Største fall", "mdd", 0, "Største fall fra topp (månedsdata)"),
    ] },
    txt("Stil", "style", 120), txt("Aktivaklasse", "asset_class", 110), txt("Utsteder", "issuer", 140), txt("Kategori", "category", 190),
    { title: "Utbytte", field: "acc", formatter: (c) => accLabel(c.getValue()) },
    { title: "Valutasikret", field: "hedged", hozAlign: "center", formatter: (c) => (c.getValue() ? "ja" : "") },
    { title: "Samme indeks", field: "cluster_size", hozAlign: "right", cssClass: "num", headerTooltip: "Antall ETF-er hos Nordnet som følger samme indeks (klikk raden)",
      formatter: (c) => (c.getValue() > 1 ? `${c.getValue()}` : "") },
  ];
}

function setupExplorer() {
  if (!window.Tabulator) { $("explorer").innerHTML = '<p class="muted">Tabellbiblioteket kunne ikke lastes.</p>'; return; }
  st.table = new Tabulator("#explorer", {
    data: [], index: "isin", layout: "fitDataFill", maxHeight: "640px", placeholder: "Ingen treff. Løsne på filtrene.",
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
         <table class="vv-table"><thead><tr><th><span class="visually-hidden">Legg til</span></th><th>Ticker</th><th>Navn</th><th class="vv-num">Kostnad</th><th>Utbytte</th><th class="vv-num">Historikk</th><th class="vv-num">Avkastning ${st.period} år</th><th>ASK</th></tr></thead><tbody>
         ${alts.sort((a, b) => (a.fee ?? 9) - (b.fee ?? 9)).map((x) => `<tr><td>${addBtn(mineSet().has(x.isin), x.name).replace("<button ", `<button data-isin="${x.isin}" `)}</td>
           <td>${esc(x.ticker)}${x.pick ? ' <span class="vv-badge">vist</span>' : ""}</td><td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>` : esc(x.name)}</td>
           <td class="vv-num">${ok(x.fee) ? nf(2).format(x.fee) + "\u00a0%" : "–"}</td><td>${accLabel(x.acc)}</td><td class="vv-num">${num(x.history_years, 1)} år</td>
           <td class="vv-num">${pct(x.m?.[st.period]?.ret)}</td><td>${x.ask ? "ja" : "nei"}</td></tr>`).join("")}
         </tbody></table>`
      : `<span class="muted">Ingen andre ETF-er hos Nordnet følger samme indeks.</span> ${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">Åpne hos Nordnet</a>` : ""}`;
    box.addEventListener("click", (ev) => { const b = ev.target.closest("button[data-isin]"); if (b) { ev.stopPropagation(); toggleSelect(b.dataset.isin); b.outerHTML = addBtn(mineSet().has(b.dataset.isin), D.by[b.dataset.isin]?.name || "").replace("<button ", `<button data-isin="${b.dataset.isin}" `); } });
    el.appendChild(box);
    row.normalizeHeight();
  });
}

async function refreshExplorer() {
  const list = filteredEtfs();
  st.filtered = list;
  const mine = mineSet();
  const rows = list.map((e) => rowOf(e, mine));
  $("f-count").innerHTML = `<strong>${num(rows.length)}</strong> ETF-er i utvalget`;
  $("exp-cols-note").innerHTML = `Avkastning per år i kroner til ${dateNo(D.summary.returns_until)}. Risikotallene gjelder ${st.period} år; tomt felt betyr for kort historikk. ` +
    'Trykk på en rad for å se andre ETF-er på samme indeks. Fagordene er forklart i <a href="#ordliste">ordlisten</a>.';
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
  if (!pts.length) { figure("fig-explorer", { title: "Ingen ETF-er med nok historikk for perioden" }); return emptyChart("chart-explorer", "Ingen ETF-er med nok historikk for perioden"); }
  const rfP = (bm?.rf ?? pts[0].m[P].rf ?? D.summary.rf_now) * 100;
  const bg = sharpeLines(pts.map((e) => e.m[P].vol * 100), pts.map((e) => e.m[P].ret * 100), rfP);
  const pt = pts.filter((e) => e.isin !== st.bench).map((e) => {
    const x = e.m[P].vol * 100, y = e.m[P].ret * 100;
    return { x, y, s: (y - rfP) / x, id: e.isin, mine: mine.has(e.isin), label: e.ticker,
      text: `<b>${esc(e.ticker)}</b> ${esc(e.name)}<br>${esc(e.sector)}${e.theme ? " · " + esc(e.theme) : ""} · ${esc(e.region)}<br>` +
        `Avkastning ${pct(e.m[P].ret)} per år · svingninger ${pct(e.m[P].vol)}<br>Avkastning for risikoen: ${sharpeWord((y - rfP) / x)} (Sharpe ${num(e.m[P].sharpe, 2)})` };
  });
  const traces = [...bg.traces, ...stepTraces(pt)];
  const good = pt.filter((x) => x.s >= 0.5).length;
  figure("fig-explorer", {
    title: `Avkastning og svingninger for ${num(pt.length)} ETF-er, ${P} år`,
    subtitle: `Avkastning og svingninger per år i kroner, ${P} år til ${dateNo(D.summary.returns_until)}. Hver prikk er en ETF, farget etter avkastning for risikoen. Trykk på en prikk for å legge den i porteføljen.`,
    takeaway: `${num(good)} av ${num(pt.length)} har gitt bra eller svært bra avkastning for risikoen. ${SHARPE_HINT}`,
    source: "Yahoo Finance (kurser og utbytte), Norges Bank (valuta og rente), egne beregninger",
    about: [["Utvalg", "ETF-ene som passer filtrene og har nok historikk for perioden."], ["Metode", '<a href="#metode-etf">Slik er tallene regnet</a>']],
    aria: `Spredningsdiagram: ${num(pt.length)} ETF-er etter svingninger og avkastning, ${P} år. ${num(good)} har gitt bra eller svært bra avkastning for risikoen.`,
    data: { name: `etf-risiko-avkastning-${P}-ar`, head: ["ETF", "Ticker", "Svingninger per år (%)", "Avkastning per år (%)", "Avkastning for risikoen"], num: [false, false, true, true, false],
      rows: pts.map((e) => [e.name, e.ticker, cell(Math.round(e.m[P].vol * 1000) / 10, pct(e.m[P].vol)), cell(Math.round(e.m[P].ret * 1000) / 10, pct(e.m[P].ret)), sharpeWord((e.m[P].ret * 100 - rfP) / (e.m[P].vol * 100))]) },
  });
  if (bm) traces.push({ type: "scatter", mode: "markers+text", name: "Referanse", x: [bm.vol * 100], y: [bm.ret * 100], customdata: [st.bench],
    text: [`<b>Referanse</b> ${esc(D.by[st.bench].name)}<br>Avkastning ${pct(bm.ret)} · svingninger ${pct(bm.vol)}`],
    texttemplate: ["Referanse"], textposition: "bottom right", textfont: { family: FONT, color: css("--chart-reference"), size: 12 }, hovertemplate: "%{text}<extra></extra>",
    marker: { color: css("--bg-000"), size: 13, symbol: "diamond", line: { color: css("--chart-reference"), width: 2.5 } } });
  plot("chart-explorer", traces, layout({
    hovermode: "closest", annotations: bg.annotations, legend: stepLegend(),
    xaxis: axis({ ticksuffix: " %", titleText: `Svingninger per år (volatilitet), ${P} år`, range: bg.xr }),
    yaxis: axis({ ticksuffix: " %", titleText: `Avkastning per år, ${P} år`, range: bg.yr }),
  }));
  const el = $("chart-explorer");
  if (!el._clickBound && el.on) {
    el.on("plotly_click", (ev) => { const i = ev.points?.[0]?.customdata; if (typeof i === "string" && i !== st.bench && st.chartTab !== "growth") toggleSelect(i); });
    el._clickBound = true;
  }
}

function renderGrowthChart() {
  const P = st.period, len = 12 * P, start = D.end - len + 1, mine = mineSet();
  let rows = st.table ? st.table.getRows("active").map((r) => r.getData()) : [];
  rows = rows.filter((r) => D.ret[r.isin] && ok(D.by[r.isin].m?.[P]?.ret)).slice(0, 10);
  if (!rows.length) { figure("fig-explorer", { title: "Ingen ETF-er med nok historikk for perioden" }); return emptyChart("chart-explorer", "Ingen ETF-er med nok historikk for perioden"); }
  const dates = []; for (let i = start - 1; i <= D.end; i++) dates.push(monthEnd(i));
  const series = rows.map((r) => ({ isin: r.isin, label: r.ticker, name: r.name, mine: mine.has(r.isin), v: E.cumulative(D.ret[r.isin], start, D.end, 100) }));
  const b = benchSeries();
  if (b && E.isNum(b[start])) series.push({ isin: st.bench, label: "Referanse", name: D.by[st.bench].name, ref: true, v: E.cumulative(b, start, D.end, 100) });
  const best = series.filter((x) => !x.ref).sort((a, b) => b.v[b.v.length - 1] - a.v[a.v.length - 1])[0];
  figure("fig-explorer", {
    title: `${esc(best.label)} har vokst mest av de 10 første i tabellen, ${P} år`,
    subtitle: `Verdien av 100 kr investert for ${P} år siden, i kroner med utbytte reinvestert. De 10 første radene i tabellen etter sorteringen din, og referansen.`,
    source: "Yahoo Finance (kurser og utbytte), Norges Bank (valuta), egne beregninger",
    about: [["Utvalg", "De 10 første radene i tabellen med historikk for hele perioden, og referansen."], ["Metode", '<a href="#metode-etf">Slik er tallene regnet</a>']],
    aria: `Linjediagram: utviklingen for de 10 første ETF-ene i tabellen. ${best.label} endte på ${num(best.v[best.v.length - 1], 0)}\u00a0kr.`,
    data: { name: `etf-utvikling-${P}-ar`, head: ["Måned", ...series.map((x) => x.label)], rows: dates.map((d, i) => [d.slice(0, 7), ...series.map((x) => cell(Math.round(x.v[i] * 10) / 10, num(x.v[i], 1)))]) },
  });
  const traces = series.map((s) => ({
    x: dates, y: s.v, mode: "lines", name: s.label, showlegend: false,
    line: { color: s.ref ? css("--chart-reference") : s.mine ? css("--chart-focus") : css("--chart-context"), width: s.ref || s.mine ? 2.5 : 1.5 },
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
    text: esc(series[e.k].label), font: { family: FONT, size: 12, color: series[e.k].ref || series[e.k].mine ? css("--ink-900") : css("--ink-700") } }));
  plot("chart-explorer", traces, layout({
    hovermode: "x unified", margin: { l: 56, r: 90, t: 16, b: 40 }, annotations: ann,
    xaxis: axis({ type: "date", tickformat: P <= 1 ? "%m.%Y" : "%Y", dtick: P <= 1 ? "M2" : P <= 5 ? "M12" : "M24", range: [dates[0], dates[dates.length - 1]] }),
    yaxis: axis({ titleText: "Verdi av 100 kr", type: useLog ? "log" : "linear" }),
  }));
}

// ---------------------------------------------------------------- portfolio membership (state lives in portefolje.js)
function mineSet() { return typeof PF !== "undefined" && PF.ids ? PF.ids() : new Set(); }

function toggleSelect(isin) {
  if (typeof PF === "undefined" || !PF.ready) return;
  PF.toggle(isin);
  const name = esc(PF.product(isin)?.name || isin), on = PF.ids().has(isin);
  toast(on ? `${ICON.check}<span>Lagt til i porteføljen: <strong>${name}</strong>. <a href="#portefolje">Se porteføljen</a></span>`
    : `<span>Fjernet fra porteføljen: <strong>${name}</strong>.</span>`);
}

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
  const steps = SHARPE_SCALE.map((z) => `<tr><th scope="row"><span class="swatch" style="background:${css(z.color)}"></span>${z.word}</th>
    <td class="vv-num">${z.lo === -Infinity ? "under 0" : z.hi === Infinity ? `${nf(z.lo === 1 ? 0 : 2).format(z.lo)} eller mer` : `${nf(2).format(z.lo)} til ${nf(2).format(z.hi)}`}</td></tr>`).join("");
  const W = [
    ["ord-avkastning", "Avkastning per år", "Hvor mye verdien har vokst i gjennomsnitt per år over perioden, med utbytte regnet med og etter fondets egne kostnader, i kroner. Ett år er mest tilfeldigheter; se etter fond som har gjort det godt over både 3, 5 og 10 år."],
    ["ord-volatilitet", "Svingninger (volatilitet)", "Hvor mye verdien svinger i løpet av et år, målt som standardavvik. En verdensindeks ligger typisk på 12–15 % i kroner, bransjefond på 18–30 %, pengemarkedsfond under 1 %. Høye svingninger betyr at du må tåle store fall underveis."],
    ["ord-sharpe", "Avkastning for risikoen (Sharpe)", `Avkastning utover risikofri rente (styringsrenten), delt på svingningene. Høyere er bedre: mer avkastning for hver prosent svingning. Siden bruker fem trinn:
      <table class="vv-table sharpe-steps"><caption class="visually-hidden">Trinnene for avkastning for risikoen</caption><thead><tr><th scope="col">Trinn</th><th scope="col" class="vv-num">Sharpe</th></tr></thead><tbody>${steps}</tbody></table>
      I risiko/avkastning-kartene skiller skrå linjer trinnene, og punktene er farget etter trinnet.`],
    ["ord-fall", "Største fall", "Det største fallet fra en topp til bunnen etter, med månedlige tall. Spør deg selv om du hadde holdt fast."],
    ["ord-alfa", "Alfa", "Avkastning utover det fondets følsomhet for markedet (beta) tilsier. Bare meningsfull når R² er rimelig høy."],
    ["ord-beta", "Beta", "Hvor mye fondet svinger med referansen. 1 betyr like mye, 1,2 betyr 20 % mer."],
    ["ord-r2", "R²", "Hvor stor del av svingningene referansen forklarer, fra 0 til 100. Over 85 betyr at fondet tilfører lite nytt til en portefølje som allerede har et globalt indeksfond."],
    ["ord-te", "Tracking error (TE) og informasjonsrate (IR)", "TE er hvor mye avkastningen avviker fra referansen per år. IR er meravkastningen mot referansen delt på TE."],
    ["ord-kostnad", "Kostnad per år", "Fond: Nordnets totalkostnad, det vil si forvaltningshonorar minus returprovisjon pluss plattformavgift. ETF-er: årlig kostnad (TER). Kostnaden er allerede trukket fra avkastningen. Kurtasje og valutapåslag ved kjøp av ETF-er kommer i tillegg."],
    ["ord-returprovisjon", "Returprovisjon", "Den delen av forvaltningshonoraret Nordnet betaler tilbake til deg."],
    ["ord-pp", "Prosentpoeng (p.p.)", "Forskjellen mellom to prosenttall. Går avkastningen fra 8 % til 9 %, er økningen 1 p.p."],
    ["ord-median", "Typisk (median)", "Den midterste verdien: halvparten ligger over, halvparten under. Påvirkes mindre av noen få ekstreme fond enn et gjennomsnitt."],
    ["ord-indeksfond", "Indeksfond, aktivt fond og ETF", "Et indeksfond kjøper alle selskapene i en indeks og er som regel billig. Et aktivt fond velger selskaper selv og koster mer. En ETF er et fond som handles på børs som en aksje."],
    ["ord-tvilling", "Tvilling", "Et annet fond eller en ETF som eier nesten det samme, målt på land, bransjer og de største selskapene. Billigere tvillinger gir i praksis samme utvikling for lavere kostnad."],
    ["ord-anslatt", "Historikk anslått", "Fond har ikke kurshistorikk hos oss. Siden låner da svingningene måned for måned fra den ETF-en som eier mest det samme, og justerer dem til fondets egen avkastning og risiko."],
    ["ord-ask", "Aksjesparekonto (ASK)", "Konto der du kan bytte fond uten å betale skatt før du tar ut gevinst. Bare fond og ETF-er fra EØS kan ligge der."],
    ["ord-akk", "Akkumulerende og utdelende", "Et akkumulerende fond legger utbyttet inn i fondet igjen. Et utdelende fond betaler det ut."],
    ["ord-sfdr", "Bærekraft (SFDR)", "EUs klassifisering: artikkel 6 har ingen bærekraftsmål, artikkel 8 fremmer bærekraft, artikkel 9 har bærekraftig investering som mål."],
  ];
  $("tips-body").innerHTML = `<dl class="glossary">${W.map(([id, t, d]) => `<div id="${id}"><dt>${t}</dt><dd>${d}</dd></div>`).join("")}</dl>
    <p>Legg kandidatene i porteføljen med «Legg til», og se under <a href="#portefolje">Min portefølje</a> hva de gjør med innhold, kostnad og risiko.</p>`;
}

function renderQuality() {
  const Q = D.quality, c = Q.coverage || {}, u = Q.universe || {}, h = c.history || {}, S = D.summary;
  $("quality").innerHTML = [
    kpi("ETF-er hos Nordnet", num(S.nordnet_n), `${num(c.active_isins)} unike ISIN`),
    kpi("Med kursdata", num(Q.n_with_returns), `månedsavkastning til ${dateNo(S.returns_until)}`),
    kpi("Minst 5 års historikk", num(h.min_5y), `minst 10 år: ${num(h.min_10y)}`),
    kpi("Indekser", num(u.n_clusters), `${num(u.n_multi_member_clusters)} med flere ETF-er`),
  ].join("");
  $("sources").innerHTML = `<dl class="glossary">
    <div><dt>Nordnet</dt><dd>Hele ETF-listen og fondslisten med kostnad, avkastning og risikotall, hentet ${dateNo(S.nordnet_run_at)}. Hva fondene og ETF-ene eier (land, bransjer, aktivaklasser og de største beholdningene) kommer fra Nordnets fond-API.</dd></div>
    <div><dt>Morningstar via Nordnet</dt><dd>Innholdet i fondene, kategoriene og R² for fond.</dd></div>
    <div><dt>Yahoo Finance</dt><dd>Daglige kurser og utbytte for ETF-ene, til ${dateNo(S.data_until)}.</dd></div>
    <div><dt>OpenFIGI</dt><dd>Oppslag fra ISIN til ticker når Nordnet og Yahoo ikke gir svar.</dd></div>
    <div><dt>Norges Bank</dt><dd>Valutakurser til kroner og styringsrenten, som brukes som risikofri rente (${esc(datesInText(S.rf_source))}, nå ${pct(S.rf_now, 2)}).</dd></div>
  </dl>
  <p>Alt hentes på nytt første virkedag i hver måned. Neste oppdatering: ${dateNo(nextUpdate(S.data_until))}.</p>`;
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
    Tracking error = standardavvik av månedlig differanse × √12, informasjonsrate = (avkastning − referansens) / TE. Risikofri rente: ${esc(datesInText(D.summary.rf_source))}.</p>
    <h3>Sektor, tema, region og stil</h3>
    <p>Utledet fra Morningstar-kategorien hos Nordnet og fondets navn med enkle, faste regler (for eksempel «Biotech» i navnet gir tema Biotek). Det kan bli feil for enkelte fond.
    «Én per indeks» bruker klyngingen av ETF-er med tracking error under ${pct(D.summary.te_threshold, 2)} mot hverandre, og viser den billigste (eller den med lengst historikk).</p>
    <p>Kontotype: ${esc(D.summary.account?.type || "ASK")}. ${D.summary.account?.tax_warning ? "Utenfor ASK utløser salg gevinstskatt." : "På ASK utløser bytte av fond ikke skatt før uttak."}</p>`;
}

function renderChanges() {
  const C = D.changes;
  $("changes-runs").innerHTML = C.runs.map((r, idx) => {
    const counts = Object.entries(r.counts).map(([k, n]) => `<span class="vv-badge">${esc(CHANGE[k] || k)}: ${num(n)}</span>`).join(" ");
    const first = idx === C.runs.length - 1 && !r.items.length;
    const items = r.items.slice(0, 200).map((x) => `<tr><td><span class="vv-badge">${esc(CHANGE[x.change] || x.change)}</span></td><td>${esc(x.symbol || "")}</td>
      <td>${esc(x.name || "")}</td><td>${esc(x.field || "")}</td><td>${esc(x.old ?? "")}</td><td>${esc(x.new ?? "")}</td></tr>`).join("");
    return `<div class="card change-run"><h3>${dateNo(r.run_at)}</h3><p class="change-counts">${counts || '<span class="muted">Ingen endringer.</span>'}</p>
      ${first ? '<p class="small-text muted">Første kjøring: alle ETF-er er registrert som nye.</p>' : items
    ? `<details class="vv-details"><summary>Vis ${num(Math.min(200, r.items.length))} endringer</summary><div class="vv-table-wrap"><table class="vv-table"><thead><tr><th scope="col">Endring</th><th scope="col">Ticker</th><th scope="col">Navn</th><th scope="col">Felt</th><th scope="col">Før</th><th scope="col">Etter</th></tr></thead><tbody>${items}</tbody></table></div></details>`
    : ""}</div>`;
  }).join("") || '<p class="muted">Ingen kjøringer.</p>';
}

document.addEventListener("DOMContentLoaded", init);
