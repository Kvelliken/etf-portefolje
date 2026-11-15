/* Min portefølje: sett sammen fond og ETF-er og få svar i klartekst:
 *   1. Hva eier jeg egentlig?        (innholdet i fondene lagt sammen, se holdings.py)
 *   2. Samme innhold, billigere tvilling
 *   3. Kostnad i kroner
 *   4. Risiko som en historie        (verste år, største fall, tid tilbake)
 *   5. Kan fordelingen bli bedre?    (mest forventet avkastning for valgt risiko)
 * Regnestykkene ligger i insight.js og engine.js. Bruker hjelpefunksjonene fra app.js og fondslisten fra fond.js.
 * Porteføljen lagres bare i nettleseren (localStorage). */
"use strict";

const I = window.Insight;
const PLS = "etfpf.portfolio.v1";
const MONTHS = ["jan.", "feb.", "mars", "april", "mai", "juni", "juli", "aug.", "sep.", "okt.", "nov.", "des."];
const TWIN = { reg: 0.9, sec: 0.85, top: 0.6, ast: 0.9, cheaper: 0.05 };   // thresholds for "nearly the same content"
const NARROW_CAP = 0.25;        // the suggestion never puts more than this in one narrow fund (sector, theme, single country, active)
const CREDIT = { vol: 0.012, corr: 0.5 };   // NOK interest funds that swing more than this are assumed to follow shares this much
const PF = {
  ready: false, items: [], plan: { start: 100000, monthly: 1000, years: 20, ret: null }, risk: "same",
  H: { items: {}, names: {} }, U: {}, S: {}, cand: null, res: null,
};

// ---------------------------------------------------------------- small helpers
const mName = (i) => { const { y, m } = monthYM(i); return `${MONTHS[m - 1]} ${y}`; };
const krRound = (x) => (ok(x) ? nf(0).format(Math.round(x / 1000) * 1000) + " kr" : "–");
const pc0 = (x) => (ok(x) ? nf(0).format(Math.round(x * 100) || 0) + " %" : "–");
function duration(months) {
  const y = Math.floor(months / 12), m = months % 12;
  const ys = y ? `${y} år` : "", ms = m ? `${m} ${m === 1 ? "måned" : "måneder"}` : "";
  return ys && ms ? `${ys} og ${ms}` : ys || ms || "under én måned";
}
function listNo(a) { return a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} og ${a[a.length - 1]}`; }
const cleanCompany = (s) => String(s || "").replace(/,?\s+(class|cl\.?|ser\.?|series)\s+[a-c]\b\.?/i, "").replace(/\s+(inc\.?|corp\.?|corporation|plc|ltd\.?|asa|ab|a\/s|oyj|n\.v\.|se|ag)\.?$/i, "").replace(/[,.\s]+$/, "").trim();
const sharpeWord = (s) => (!ok(s) ? "–" : s < 0.15 ? "svak" : s < 0.35 ? "middels" : s < 0.6 ? "god" : "svært god");
function sharpeColor(s) {
  const stops = [[-0.5, [201, 48, 44]], [0, [232, 116, 59]], [0.5, [242, 208, 74]], [1, [143, 202, 92]], [1.5, [46, 158, 79]]];
  const x = Math.max(-0.5, Math.min(1.5, s));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i], f = (x - a) / (b - a);
      return `rgb(${ca.map((v, k) => Math.round(v + f * (cb[k] - v))).join(",")})`;
    }
  }
  return "rgb(46,158,79)";
}

// ---------------------------------------------------------------- colour per fund (follows the fund, never its rank)
const SLOTS = 8;
function assignColors() {
  const used = new Set(PF.items.map((x) => x.c).filter((c) => Number.isInteger(c) && c < SLOTS));
  for (const it of PF.items) {
    if (Number.isInteger(it.c)) continue;
    let k = 0; while (used.has(k) && k < SLOTS) k++;
    it.c = k; used.add(k);                       // past eight funds: neutral
  }
}
const colorOf = (it) => (it && Number.isInteger(it.c) && it.c < SLOTS ? css(`--s${it.c + 1}`) : css("--axis"));
const swatch = (it) => `<span class="swatch" style="background:${colorOf(it)}"></span>`;
/** Segmented 100 % bar. parts = [{label, w (0..1), color, title}] */
function mixbar(el, parts) {
  const p = parts.filter((x) => x.w > 0.002);
  (typeof el === "string" ? $(el) : el).innerHTML = p.map((x) => `<span class="seg" style="flex:${(x.w * 100).toFixed(2)} 0 0;background:${x.color}" title="${esc(x.title || x.label)}: ${pc0(x.w)}">${x.w >= 0.11 ? `<b>${pc0(x.w)}</b>` : ""}</span>`).join("");
}

// ---------------------------------------------------------------- products (funds and ETFs alike)
function isRate(x) { return x.asset_class === "Renter" || x.asset_class === "Pengemarked"; }

function product(id) {
  if (PF.U[id]) return PF.U[id];
  const e = D.by[id], f = FS.by[id];
  let p = null;
  if (e) {
    p = { id, kind: "etf", name: e.name, ticker: e.ticker, url: e.url, cost: e.fee, asset_class: e.asset_class, category: e.category,
      index: e.style !== "Aktiv", ask: !!e.ask, hedged: !!e.hedged, leveraged: !!e.leveraged || e.asset_class === "Giret/invers",
      owners: e.owners, cluster: e.cluster_size > 1 ? e.cluster : null, currency: e.currency, tradable: true,
      ret: { 1: e.m?.[1]?.ret, 3: e.m?.[3]?.ret, 5: e.m?.[5]?.ret, 10: e.m?.[10]?.ret }, vol: e.m?.[5]?.vol ?? e.m?.[3]?.vol ?? e.m?.[1]?.vol,
      kindLabel: isRate(e) ? "Rente-ETF" : "ETF" };
  } else if (f) {
    p = { id, kind: "fond", name: f.name, ticker: "", url: f.url, cost: f.cost, asset_class: f.asset_class, category: f.category,
      index: !!f.index, ask: !!f.ask, hedged: !!f.hedged, leveraged: false, owners: f.owners, cluster: null, currency: f.currency,
      tradable: f.tradable !== false, ret: { 1: f.r1, 3: f.r3, 5: f.r5, 10: f.r10 }, vol: f.vol5 ?? f.vol3 ?? f.vol1,
      kindLabel: isRate(f) ? "Rentefond" : f.index ? "Indeksfond" : f.asset_class === "Blandet" ? "Kombinasjonsfond" : "Aktivt fond" };
  }
  if (p) PF.U[id] = p;
  return p;
}
const holdingsOf = (id) => PF.H.items[id] || null;
function allProducts() {
  if (!PF.all) PF.all = [...FS.list.map((f) => f.isin), ...D.list.map((e) => e.isin)];
  return PF.all.map(product).filter(Boolean);
}

// ---------------------------------------------------------------- monthly series (own, or estimated for funds)
/** {s, kind: own | proxy | synthetic, proxy} for any product. Funds have no price history: they borrow the
 *  monthly pattern of the most similar ETF, shifted so the last years give exactly the fund's own return. */
function seriesOf(id) {
  if (PF.S[id]) return PF.S[id];
  const p = product(id);
  let out = null;
  if (p.kind === "etf") {
    const r = seriesFor(id, true);
    out = r ? { s: r.s, kind: "own", ext: r.ext } : null;
  } else out = fundSeries(FS.by[id], p);
  if (out) { out.from = E.firstIdx(out.s); PF.S[id] = out; }
  return out;
}

function proxyCandidates() {
  if (PF.cand) return PF.cand;
  PF.cand = D.list.filter((e) => D.ret[e.isin] && !e.leveraged && e.asset_class !== "Giret/invers" && e.l0 === D.end && e.f0 >= 0 && D.end - e.f0 >= 35);
  return PF.cand;
}

function fundSeries(f, p) {
  const P = [5, 3, 1].find((y) => ok(f[`r${y}`]));
  const target = P ? [P, f[`r${P}`]] : null;
  const synthetic = () => {
    const vol = ok(p.vol) ? p.vol : 0.01, b = benchSeries(), bv = D.by[st.bench]?.m?.[10]?.vol ?? D.by[st.bench]?.m?.[5]?.vol;
    const credit = isRate(f) && vol > CREDIT.vol;
    return { s: I.proxySeries(null, D.rf, D.end, { vol, target, ...(credit ? { mkt: b, mktVol: bv, corr: CREDIT.corr } : {}) }), kind: "synthetic", credit };
  };
  if (isRate(f) && f.currency === "NOK") return synthetic();          // NOK interest funds: no comparable ETF in kroner
  const h = holdingsOf(f.isin);
  let best = null;
  if (h) {
    const scored = [];
    for (const e of proxyCandidates()) {
      if (e.asset_class !== f.asset_class || !!e.hedged !== !!f.hedged) continue;
      const sim = I.similarity(h, holdingsOf(e.isin));
      if (sim) scored.push({ e, sim: sim.score, months: D.end - (seriesFor(e.isin, true)?.s ? E.firstIdx(seriesFor(e.isin, true).s) : e.f0) });
    }
    // among the ETFs that are about as alike as the best one, take the longest history (a risk story needs bad years)
    const top = Math.max(0, ...scored.map((x) => x.sim));
    best = scored.filter((x) => x.sim >= top - 0.08).sort((a, b) => b.months - a.months || b.sim - a.sim)[0] || null;
    if (best && best.sim < 0.3) best = null;                           // nothing alike: fall back to the category
  }
  if (!best) {
    const same = proxyCandidates().filter((e) => e.category === f.category && !!e.hedged === !!f.hedged);
    const key = (e) => (ok(p.vol) && ok(e.m?.[5]?.vol) ? Math.abs(Math.log(e.m[5].vol / p.vol)) : 5 - Math.min(4, (e.fund_size || 0) / 1e10));
    if (same.length) best = { e: same.sort((a, b) => key(a) - key(b))[0], sim: 0 };
  }
  if (!best) return synthetic();
  const e = best.e, ev = e.m?.[5]?.vol ?? e.m?.[3]?.vol;
  const k = best.sim >= 0.85 || !ok(p.vol) || !ok(ev) || ev <= 0 ? 1 : Math.max(0.5, Math.min(1.8, p.vol / ev));
  const src = seriesFor(e.isin, true).s;
  return { s: I.proxySeries(src, D.rf, D.end, { k, target, drag: ((f.cost ?? 0) - (e.fee ?? 0)) / 100 }), kind: "proxy", proxy: e.isin, sim: best.sim };
}

/** Broad building blocks (may take any share in the suggestion): low-risk interest funds, mixed funds and index
 *  funds spread over several regions and sectors. Everything else is narrow: active, one sector/theme/country. */
function isBroad(p) {
  if (isRate(p)) return ok(p.vol) && p.vol <= 0.03;
  if (p.asset_class === "Blandet") return true;
  const h = holdingsOf(p.id);
  if (!p.index || p.asset_class !== "Aksjer" || !h) return false;
  const big = (o, lim) => Object.values(o || {}).filter((v) => v >= lim).length;
  return big(h.reg, 4) >= 3 && Math.max(0, ...Object.values(h.sec || {})) <= 40;
}

// ---------------------------------------------------------------- twins
function twinLabel(sameIndex, sim, rate) {
  if (sameIndex) return "Samme indeks";
  if (rate) return "Samme type rentefond";
  return `${sim.score >= 0.9 ? "Nesten identisk" : "Svært likt"} (${pc0(sim.score)})`;
}
function isTwin(sim) {
  return !!sim && ok(sim.reg) && ok(sim.sec) && ok(sim.top) && sim.reg >= TWIN.reg && sim.sec >= TWIN.sec && sim.top >= TWIN.top && (!ok(sim.ast) || sim.ast >= TWIN.ast);
}
/** Interest funds rarely have comparable holdings: same category and currency, about the same swings and
 *  about the same return before costs (a high-yield fund is not the twin of a government bond fund). */
function rateTwin(p, c) {
  if (!isRate(p) || !isRate(c) || p.category !== c.category || p.currency !== c.currency || !ok(p.vol) || !ok(c.vol)) return false;
  const P = [5, 3].find((y) => ok(p.ret[y]) && ok(c.ret[y]));
  if (!P || Math.abs(p.ret[P] + p.cost / 100 - c.ret[P] - c.cost / 100) > 0.006) return false;
  const lo = Math.min(p.vol, c.vol), hi = Math.max(p.vol, c.vol);
  return hi < 0.01 || hi / Math.max(lo, 1e-6) <= 1.3;
}
/** Funds and ETFs that own nearly the same as `id`. Default: only cheaper ones. Cheapest first. */
function twinsOf(id, opt = {}) {
  const p = product(id), h = holdingsOf(id);
  if (!p) return [];
  const found = [];
  for (const c of allProducts()) {
    if (c.id === id || c.asset_class !== p.asset_class || c.leveraged || !c.tradable || c.hedged !== p.hedged || (p.ask && !c.ask) || !ok(c.cost)) continue;
    const sameIndex = p.cluster !== null && c.cluster === p.cluster;
    const sim = h ? I.similarity(h, holdingsOf(c.id)) : null;
    const rate = !sameIndex && !isTwin(sim) && rateTwin(p, c);
    if (!sameIndex && !isTwin(sim) && !rate) continue;
    found.push({ p: c, sameIndex, score: sameIndex ? 1 : rate ? 0.8 : sim.score, label: twinLabel(sameIndex, sim, rate) });
  }
  found.sort((a, b) => a.p.cost - b.p.cost || b.score - a.score || (b.p.owners || 0) - (a.p.owners || 0));
  const seen = new Set(), out = [];
  for (const t of found) {                      // one ETF per index
    const key = t.p.cluster !== null ? `c${t.p.cluster}` : t.p.id;
    if (seen.has(key)) continue;
    seen.add(key); out.push(t);
  }
  return opt.all ? out : out.filter((t) => ok(p.cost) && t.p.cost < p.cost - TWIN.cheaper);
}

// ---------------------------------------------------------------- state
function savePF() { assignColors(); store.set(PLS, { items: PF.items, plan: PF.plan, risk: PF.risk, profile: PF.profile ?? null }); }
PF.ids = () => new Set(PF.items.map((x) => x.id));
PF.product = product;
PF.twinsOf = twinsOf;
PF.toggle = (id) => {
  const i = PF.items.findIndex((x) => x.id === id);
  if (i >= 0) removeItem(i); else addItem(id);
};
PF.refresh = () => { PF.U = {}; PF.S = {}; PF.cand = null; if (PF.ready) { renderPfTable(); analyse(); renderReco(); } };

function scaleTo100() {
  const s = PF.items.reduce((a, x) => a + (+x.w || 0), 0);
  if (s <= 0) { PF.items.forEach((x) => { x.w = 100 / PF.items.length; }); return roundWeights(); }
  PF.items.forEach((x) => { x.w = (+x.w || 0) * 100 / s; });
  roundWeights();
}
/** Whole percent that still sum to 100 (largest remainders). */
function roundWeights() {
  const fl = PF.items.map((x) => Math.floor(x.w)), rest = 100 - fl.reduce((a, b) => a + b, 0);
  const order = PF.items.map((x, i) => [x.w - fl[i], i]).sort((a, b) => b[0] - a[0]);
  PF.items.forEach((x, i) => { x.w = fl[i]; });
  for (let k = 0; k < rest && k < order.length; k++) PF.items[order[k][1]].w += 1;
}
function addItem(id) {
  if (!product(id) || PF.items.some((x) => x.id === id)) return;
  const n = PF.items.length;
  PF.items.forEach((x) => { x.w = (+x.w || 0) * n / (n + 1); });
  PF.items.push({ id, w: 100 / (n + 1) });
  scaleTo100();
  membersChanged();
}
function removeItem(i) {
  PF.items.splice(i, 1);
  if (PF.items.length) scaleTo100();
  membersChanged();
}
function swapItem(id, withId) {
  const it = PF.items.find((x) => x.id === id);
  if (!it || !product(withId)) return;
  const other = PF.items.find((x) => x.id === withId);
  if (other) { other.w += it.w; PF.items.splice(PF.items.indexOf(it), 1); } else it.id = withId;
  membersChanged();
}
function membersChanged() {
  PF.risk = "same";
  savePF();
  renderPfTable();
  analyse();
  if (typeof onPortfolioMembers === "function") onPortfolioMembers();
  if (typeof onPortfolioMembersFond === "function") onPortfolioMembersFond();
}
const analyseLater = debounce(() => { savePF(); analyse(); }, 150);

// ---------------------------------------------------------------- setup
function setupPortfolio() {
  const wait = () => (D.ready ? ensureFond().then(() => fetch("data/innhold.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)) : new Promise((res) => setTimeout(res, 80)).then(wait));
  wait().then((H) => {
    if (!FS.data) return;                       // fund data failed: fond.js has shown the error
    if (H && H.items) PF.H = H;
    else notice($("pf-status"), "warning", "<strong>⚠ Innholdet i fondene mangler:</strong> «Hva eier jeg egentlig?» og tvillinger kan ikke vises før <code>data/innhold.json</code> er laget.");
    const saved = store.get(PLS, null);
    if (saved) { PF.items = (saved.items || []).filter((x) => product(x.id)); Object.assign(PF.plan, saved.plan || {}); PF.risk = saved.risk ?? "same"; PF.profile = saved.profile ?? null; }
    readPfHash();
    assignColors();
    bindPlan(); bindSearch(); bindButtons(); bindReco();
    $("reco").open = !PF.items.length;
    renderPfMethod();
    PF.ready = true;
    renderPfTable();
    analyse();
    redraw.push(() => { if (PF.res) renderCharts(); });
    onPortfolioMembers(); onPortfolioMembersFond();
  });
}

function readPfHash() {
  const m = location.hash.match(/^#pf=(.+)$/);
  if (!m) return;
  const items = m[1].split(",").map((s) => { const [id, w] = s.split(":"); return { id, w: Math.max(0, +w || 0) }; }).filter((x) => product(x.id));
  if (items.length) { PF.items = items; PF.risk = "same"; savePF(); }
  history.replaceState(null, "", location.pathname + location.search);
}

function bindPlan() {
  const map = { "pl-start": "start", "pl-monthly": "monthly", "pl-years": "years", "pl-ret": "ret" };
  for (const [id, key] of Object.entries(map)) {
    const el = $(id);
    el.value = PF.plan[key] ?? "";
    el.addEventListener("input", () => {
      const v = el.value === "" ? null : +el.value;
      PF.plan[key] = key === "ret" ? (ok(v) && v >= 0 ? v : null) : key === "years" ? Math.max(1, Math.min(50, Math.round(v || 1))) : Math.max(0, v || 0);
      updateAmounts(); analyseLater();
      if (key === "years" && PF.profile == null) renderReco();
    });
  }
}

function searchProducts(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const mine = PF.ids();
  return allProducts().filter((p) => {
    if (mine.has(p.id) || p.leveraged || !p.tradable) return false;
    const hay = `${p.name} ${p.ticker} ${p.id} ${p.kindLabel}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }).sort((a, b) => (b.owners || 0) - (a.owners || 0)).slice(0, 12);
}
function bindSearch() {
  const q = $("pf-q"), box = $("pf-results");
  const close = () => { box.hidden = true; q.setAttribute("aria-expanded", "false"); };
  const show = () => {
    const res = searchProducts(q.value);
    if (!q.value.trim()) return close();
    box.innerHTML = res.length ? res.map((p) => `<button type="button" role="option" data-id="${esc(p.id)}">
        <span class="nm">${esc(p.name)}</span><span class="tag">${esc(p.kindLabel)}</span>
        <span class="muted">${ok(p.cost) ? nf(2).format(p.cost) + " % per år" : ""}${ok(p.ret[5]) ? " · 5 år: " + pct(p.ret[5]) : ""}</span></button>`).join("")
      : '<p class="muted">Ingen treff. Prøv færre ord, eller bruk Finn fond / Finn ETF-er.</p>';
    box.hidden = false; q.setAttribute("aria-expanded", "true");
  };
  q.addEventListener("input", debounce(show, 120));
  q.addEventListener("focus", show);
  q.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
    if (ev.key === "Enter") { const b = box.querySelector("button[data-id]"); if (b && !box.hidden) b.click(); }
  });
  box.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-id]"); if (!b) return;
    addItem(b.dataset.id); q.value = ""; close(); q.focus();
  });
  document.addEventListener("click", (ev) => { if (!ev.target.closest(".pf-search")) close(); });
}

// ---------------------------------------------------------------- recommended portfolio
const PROFILES = [[20, "Forsiktig"], [40, "Moderat"], [60, "Balansert"], [80, "Offensiv"], [100, "Bare aksjer"]];
const RECO = { core: 0.8, em: 0.1, small: 0.1, minPiece: 3 };       // split of the share part; pieces under 3 % go to the core
const ROLES = {
  core: ["Kjernen", "Rundt 1 500 store selskaper i hele den rike verden, i ett billig fond."],
  em: ["Fremvoksende markeder", "Kina, India, Taiwan, Brasil med flere – de mangler i det globale fondet."],
  small: ["Små selskaper", "Tusenvis av mindre selskaper verden over, som de store indeksene hopper over."],
  safe: ["Bufferen", "Korte, sikre renter i kroner. Demper fallene, og gir ro til å sitte stille når aksjer faller."],
};
/** Building blocks, picked from this month's data: index funds in NOK with at least 1 000 owners and a cost within
 *  0.15 points of the cheapest; among those within half a point of the best five-year return (they track well), the cheapest. */
function recoBlocks() {
  if (PF.blocks) return PF.blocks;
  const pick = (fn) => {
    const all = FS.list.filter((f) => ok(f.cost) && ok(f.r5) && f.tradable !== false && f.currency === "NOK" && (f.owners || 0) >= 1000 && !f.hedged && fn(f));
    if (!all.length) return null;
    const cheap = Math.min(...all.map((f) => f.cost)), c = all.filter((f) => f.cost <= cheap + 0.15);       // only the cheap ones compete
    const best = Math.max(...c.map((f) => f.r5));
    return c.filter((f) => f.r5 >= best - 0.005).sort((a, b) => a.cost - b.cost || (b.owners || 0) - (a.owners || 0))[0].isin;
  };
  const idx = (cat) => (f) => f.index && f.ask && !f.esg && f.category === cat;
  PF.blocks = { core: pick(idx("Global Equity Large Cap")), em: pick(idx("Global Emerging Markets Equity")), small: pick(idx("Global Equity Mid/Small Cap")),
    safe: pick((f) => isRate(f) && ok(f.vol5) && f.vol5 < 0.012) };
  return PF.blocks;
}
function defaultProfile() { const y = PF.plan.years; return y <= 2 ? 20 : y <= 5 ? 40 : y <= 9 ? 60 : 80; }
/** [{id, w (percent), role}] for a share of equities (percent). */
function recoFor(eq) {
  const B = recoBlocks();
  if (!B.core || !B.safe) return null;
  const raw = { core: eq * RECO.core, em: B.em ? eq * RECO.em : 0, small: B.small ? eq * RECO.small : 0, safe: 100 - eq };
  raw.core = eq - raw.em - raw.small;
  for (const k of ["em", "small"]) if (raw[k] < RECO.minPiece) { raw.core += raw[k]; raw[k] = 0; }
  const out = ["core", "em", "small", "safe"].filter((k) => raw[k] > 0).map((k) => ({ id: B[k], w: Math.round(raw[k]), role: k }));
  out[0].w += 100 - out.reduce((a, x) => a + x.w, 0);
  return out;
}
const ROLE_COLOR = { core: 1, em: 3, small: 4, safe: 2 };
function renderReco() {
  const prof = PF.profile ?? defaultProfile(), rec = recoFor(prof), box = $("reco");
  if (!rec) { box.hidden = true; return; }
  $("reco-profile").innerHTML = PROFILES.map(([e, name]) => `<button type="button" role="tab" data-e="${e}" aria-selected="${e === prof}">${name}<span class="muted">${e} % aksjer</span></button>`).join("");
  const y = PF.plan.years, d = defaultProfile(), dn = PROFILES.find((x) => x[0] === d)[1];
  $("reco-why").innerHTML = `Med ${y} års sparing er <strong>${dn}</strong> utgangspunktet vårt: ${y <= 2 ? "pengene skal brukes snart, så de bør ikke svinge mye." : y <= 5 ? "noen år er for kort til å tåle et stort aksjefall rett før du trenger pengene." : y <= 9 ? "du har tid til å hente inn et fall, men ikke ubegrenset." : "du har god tid til å hente inn fall, og aksjer gir mest over lang tid. En liten buffer gjør det lettere å sitte stille."}
    Tåler du dårlig å se pengene falle, gå ett hakk ned – det viktigste er en fordeling du klarer å holde fast ved.`;
  mixbar("reco-bar", rec.map((x) => ({ label: ROLES[x.role][0], w: x.w / 100, color: css(`--s${ROLE_COLOR[x.role]}`) })));
  $("reco-list").innerHTML = rec.map((x) => { const p = product(x.id); return `<div class="reco-row"><span class="swatch" style="background:${css(`--s${ROLE_COLOR[x.role]}`)}"></span>
      <div class="reco-w">${x.w} %</div><div><strong>${esc(ROLES[x.role][0])}</strong> · ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}
      <span class="tag">${nf(2).format(p.cost)} % per år</span><br><span class="muted">${esc(ROLES[x.role][1])}</span></div></div>`; }).join("");
  const tot = 100, use = rec.map((x) => ({ item: x, p: product(x.id), w: x.w / tot, ser: seriesOf(x.id) }));
  const ev = evaluate(use);
  $("reco-stats").innerHTML = [
    ["Forventet avkastning", ev.model ? pct(ev.model.now.ret) + " per år" : "–"],
    ["Verste år", ev.story ? `${pc0(ev.story.worst.ret)} (100 000 → ${krRound(100000 * (1 + ev.story.worst.ret))})` : "–"],
    ["Kostnad", `${nf(2).format(ev.cost * 100)} % per år`],
  ].map(([a, b]) => `<div><span class="muted">${a}</span><strong>${b}</strong></div>`).join("");
  PF.reco = rec;
}
function bindReco() {
  $("reco-profile").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-e]"); if (!b) return;
    PF.profile = +b.dataset.e; savePF(); renderReco();
  });
  $("reco-use").addEventListener("click", () => {
    if (!PF.reco) return;
    if (PF.items.length && !confirm("Erstatte porteføljen din med den anbefalte?")) return;
    PF.items = PF.reco.map((x) => ({ id: x.id, w: x.w, c: ROLE_COLOR[x.role] - 1 }));
    $("reco").open = false;
    membersChanged();
    $("pf-innhold").scrollIntoView();
  });
  renderReco();
}

function bindButtons() {
  $("pf-equal").addEventListener("click", () => { PF.items.forEach((x) => { x.w = 100 / PF.items.length; }); roundWeights(); membersChanged(); });
  $("pf-norm").addEventListener("click", () => { scaleTo100(); membersChanged(); });
  $("pf-clear").addEventListener("click", () => { if (PF.items.length && confirm("Fjerne alt fra porteføljen?")) { PF.items = []; membersChanged(); } });
  $("pf-link").addEventListener("click", (ev) => {
    const url = `${location.origin}${location.pathname}#pf=${PF.items.map((x) => `${x.id}:${Math.round(x.w)}`).join(",")}`;
    const b = ev.target, done = () => { b.textContent = "Kopiert ✓"; setTimeout(() => { b.textContent = "Kopier lenke"; }, 1800); };
    (navigator.clipboard?.writeText(url) || Promise.reject()).then(done).catch(() => prompt("Kopier lenken:", url));
  });
  $("pf-table").addEventListener("input", (ev) => {
    const el = ev.target.closest("input[data-i]"); if (!el) return;
    const it = PF.items[+el.dataset.i]; if (!it) return;
    it.w = Math.max(0, Math.min(100, +el.value || 0));
    const tr = el.closest("tr");
    tr.querySelectorAll("input[data-i]").forEach((o) => { if (o !== el) o.value = it.w; });
    PF.risk = "same";
    updateAmounts(); analyseLater();
  });
  $("pf-table").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-rm]"); if (b) removeItem(+b.dataset.rm);
  });
  $("twins").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-swap]"); if (b) swapItem(b.dataset.swap, b.dataset.with);
  });
  $("sg-risk").addEventListener("input", () => { PF.risk = +$("sg-risk").value; savePF(); renderSuggestion(); renderMap(); });
  $("sg-same").addEventListener("click", () => { PF.risk = "same"; savePF(); renderSuggestion(); renderMap(); });
  $("sg-apply").addEventListener("click", () => {
    const sg = PF.res?.sg; if (!sg) return;
    PF.res.use.forEach((u, k) => { u.item.w = sg.w[k] * 100; });
    PF.items = PF.items.filter((x) => x.w >= 0.5 || !PF.res.use.some((u) => u.item === x));
    scaleTo100(); membersChanged();
    $("pf-bygg").scrollIntoView();
  });
}

// ---------------------------------------------------------------- portfolio table
function renderPfTable() {
  const el = $("pf-table"), n = PF.items.length;
  const cnt = $("pf-count"); cnt.hidden = !n; cnt.textContent = n;
  $("pf-body").hidden = !n; $("glance-body").hidden = !n; $("glance-empty").hidden = !!n;
  assignColors();
  ["pf-equal", "pf-norm", "pf-link", "pf-clear"].forEach((id) => { $(id).disabled = !n; });
  if (!n) {
    el.innerHTML = `<tbody><tr><td class="empty"><strong>Porteføljen er tom.</strong> Bruk den anbefalte porteføljen over, eller søk etter fondene du allerede har. Du kan alltid justere andelene etterpå.</td></tr></tbody>`;
    return;
  }
  const rows = PF.items.map((it, i) => {
    const p = product(it.id), s = seriesOf(it.id);
    const est = p.kind === "fond" ? `<span class="tag est" title="${s?.kind === "proxy" ? "Fond har ikke kurshistorikk hos oss. Månedlige svingninger er lånt fra " + esc(D.by[s.proxy]?.name || "en lignende ETF") + " og justert til fondets egen avkastning og risiko." : "Fond har ikke kurshistorikk hos oss. Svingningene er anslått fra fondets egen avkastning og risiko."}">historikk anslått</span>` : "";
    return `<tr><td><button type="button" class="add-btn" data-rm="${i}" aria-label="Fjern ${esc(p.name)}">×</button></td>
      <td class="wide">${swatch(it)}${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}<br><span class="tag">${esc(p.kindLabel)}</span> ${est}</td>
      <td class="share"><input type="range" min="0" max="100" step="1" value="${Math.round(it.w)}" data-i="${i}" aria-label="Andel ${esc(p.name)}">
        <input type="number" min="0" max="100" step="1" value="${Math.round(it.w)}" data-i="${i}" aria-label="Andel i prosent"> %</td>
      <td class="num" data-kr="${i}"></td><td class="num">${ok(p.cost) ? nf(2).format(p.cost) + " %" : "–"}</td>
      <td class="num hide-narrow">${pct(p.ret[5])}</td><td class="num hide-narrow">${pct(p.vol)}</td></tr>`;
  }).join("");
  el.innerHTML = `<thead><tr><th></th><th>Fond / ETF</th><th>Andel</th><th class="num">Av det du har i dag</th><th class="num" title="Det du betaler per år, i prosent av beløpet">Kostnad per år</th>
    <th class="num hide-narrow" title="Avkastning per år de siste 5 årene, i kroner, etter kostnader">Avkastning 5 år</th><th class="num hide-narrow" title="Hvor mye verdien svinger i løpet av et år (volatilitet)">Svingninger</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr class="total"><td></td><td>Sum</td><td id="pf-sum"></td><td class="num" id="pf-sum-kr"></td><td class="num" id="pf-sum-cost"></td><td class="hide-narrow"></td><td class="hide-narrow"></td></tr></tfoot>`;
  updateAmounts();
}
function updateAmounts() {
  const sum = PF.items.reduce((a, x) => a + (+x.w || 0), 0);
  PF.items.forEach((it, i) => { const c = document.querySelector(`[data-kr="${i}"]`); if (c) c.textContent = kr(PF.plan.start * (sum > 0 ? it.w / sum : 0)); });
  const s = $("pf-sum"); if (!s) return;
  const off = Math.abs(sum - 100) > 0.5;
  s.innerHTML = `${nf(0).format(sum)} %${off ? ' <span class="tag warn">regnes om til 100 %</span>' : ""}`;
  $("pf-sum-kr").textContent = kr(PF.plan.start);
  const cost = sum > 0 ? PF.items.reduce((a, x) => a + (x.w / sum) * (product(x.id).cost ?? 0), 0) : null;
  $("pf-sum-cost").textContent = ok(cost) ? nf(2).format(cost) + " %" : "–";
}

// ---------------------------------------------------------------- analysis
/** History, risk story and model for a set of holdings [{item, p, w, ser}] (weights sum to 1). */
function evaluate(use) {
  const withSer = use.filter((u) => u.ser && u.ser.from >= 0);
  const res = { use, missing: use.filter((u) => !withSer.includes(u)) };
  res.cost = use.reduce((a, u) => a + u.w * (u.p.cost ?? 0), 0) / 100;
  const hs = withSer.length === use.length ? withSer : [];
  if (!hs.length) return res;
  let from = Math.max(...hs.map((u) => u.ser.from));
  for (let t = D.end; t >= from; t--) if (hs.some((u) => !E.isNum(u.ser.s[t]))) { from = t + 1; break; }
  res.from = from; res.months = D.end - from + 1;
  if (res.months < 13) return res;
  const w = hs.map((u) => u.w);
  const mix = (ww) => { const r = new Float64Array(D.n).fill(NaN); for (let t = from; t <= D.end; t++) { let x = 0; for (let k = 0; k < hs.length; k++) x += ww[k] * hs[k].ser.s[t]; r[t] = x; } return r; };
  res.mix = mix; res.r = mix(w); res.story = I.riskStory(res.r, from, D.end);
  // model: covariance from the last 5 years (or what there is), expected return = equilibrium + a little history, after costs
  const def = D.summary.defaults, b = benchSeries();
  const eFrom = Math.max(from, D.end - def.estimation_years * 12 + 1, E.firstIdx(b));
  if (D.end - eFrom + 1 < 12) return res;
  const est = estimate(hs.map((u) => u.ser.s), b, eFrom, D.end);
  const rf = D.summary.rf_now, h = def.history_weight;
  const mu = Float64Array.from(hs, (u, k) => (1 - h) * (rf + est.beta[k] * def.market_risk_premium - (u.p.cost ?? 0) / 100) + h * est.hist[k]);
  const perf = (ww) => { let ret = 0, v = 0; for (let i = 0; i < ww.length; i++) { ret += ww[i] * mu[i]; for (let j = 0; j < ww.length; j++) v += ww[i] * ww[j] * est.S[i][j]; } const vol = Math.sqrt(Math.max(v, 0)); return { ret, vol, sharpe: vol > 1e-9 ? (ret - rf) / vol : null }; };
  res.model = { est, mu, rf, perf, now: perf(w), eMonths: D.end - eFrom + 1 };
  // share of the swings each holding stands for
  const tot = w.reduce((a, wi, i) => a + wi * w.reduce((c, wj, j) => c + wj * est.S[i][j], 0), 0);
  res.model.rc = w.map((wi, i) => (tot > 0 ? wi * w.reduce((c, wj, j) => c + wj * est.S[i][j], 0) / tot : 0));
  if (hs.length >= 2) {
    const lo = new Float64Array(hs.length), hi = Float64Array.from(hs, (u) => (isBroad(u.p) ? 1 : NARROW_CAP));
    res.capped = hs.filter((u, k) => hi[k] < 1).map((u) => u.p.name);
    if (hi.reduce((a, b2) => a + b2, 0) < 1) { hi.fill(1); res.capped = []; }      // only narrow funds: no cap possible
    res.model.frontier = E.frontier(mu, est.S, lo, hi, rf, 40).points;
  }
  return res;
}

function analyse() {
  if (!PF.ready) return;
  const total = PF.items.reduce((a, x) => a + (+x.w || 0), 0);
  const use = PF.items.filter((x) => x.w > 0 && total > 0).map((item) => ({ item, p: product(item.id), w: item.w / total, ser: seriesOf(item.id) }));
  if (!use.length) { PF.res = null; return; }
  const res = evaluate(use);
  res.total = total;
  res.look = I.lookThrough(use.map((u) => ({ w: u.w, h: holdingsOf(u.p.id) })));
  res.twins = use.map((u) => twinsOf(u.p.id));
  PF.res = res;
  renderKpis(); renderOwn(); renderTwins(); renderCost(); renderRisk(); renderOutcomes(); renderSuggestion(); renderMap();
}
function renderCharts() { renderKpis(); renderOwn(); renderCost(); renderRisk(); renderOutcomes(); renderSuggestion(); renderMap(); renderReco(); }

function grossReturn() {
  const res = PF.res;
  if (ok(PF.plan.ret)) return PF.plan.ret / 100;
  const g = res?.model ? res.model.now.ret + res.cost : 0.06;
  return Math.round(g * 200) / 200;                 // nearest half percent
}

function renderKpis() {
  const res = PF.res, m = res.model?.now, st = res.story;
  const sh = m?.sharpe;
  $("pf-kpis").innerHTML = [
    kpi("Forventet avkastning", m ? pct(m.ret) : "–", "per år etter kostnader – et anslag, ikke et løfte"),
    kpi("Det verste året", st ? pc0(st.worst.ret) : "–", st ? `100 000 kr ble til ${krRound(100000 * (1 + st.worst.ret))} (${mName(st.worst.from)}–${mName(st.worst.to)})` : "for kort historikk"),
    kpi("Kostnad", `${nf(2).format(res.cost * 100)} %`, `${kr(PF.plan.start * res.cost)} i år av ${kr(PF.plan.start)}`),
    kpi("Avkastning for risikoen", ok(sh) ? `<span class="chip" style="background:${sharpeColor(sh)}"></span>${sharpeWord(sh)}` : "–",
      ok(sh) ? `Sharpe ${nf(2).format(sh)}: forventet avkastning utover banken, delt på svingningene` : ""),
  ].join("");
  $("pl-ret").placeholder = nf(1).format(grossReturn() * 100);
  mixbar("pf-mix", res.use.map((u) => ({ label: u.p.name, w: u.w, color: colorOf(u.item) })));
  $("pf-mix-legend").innerHTML = res.use.map((u) => `<div>${swatch(u.item)}<span class="nm">${esc(u.p.name)}</span><span class="val">${pc0(u.w)}</span></div>`).join("");
  const vol = m?.vol, pos = ok(vol) ? Math.min(1, vol / 0.25) : null;
  $("meter-dot").style.left = ok(pos) ? `${(pos * 100).toFixed(1)}%` : "0%";
  $("meter-dot").hidden = !ok(pos);
  $("meter-label").textContent = !ok(vol) ? "–" : `${vol < 0.015 ? "Svært lavt" : vol < 0.05 ? "Lavt" : vol < 0.09 ? "Middels" : vol < 0.135 ? "Høyt" : "Svært høyt"} · svinger ${pct(vol, 0)} i året`;
}

// ---------------------------------------------------------------- 1. what do I own
function bars(el, rows, opt = {}) {
  const max = Math.max(...rows.map((r) => r[1]), 1e-9);
  $(el).innerHTML = rows.length ? rows.map(([name, v, sub]) => `<div class="bar-row"><span class="nm" title="${esc(name)}">${esc(name)}${sub ? ` <span class="muted">${esc(sub)}</span>` : ""}</span>
    <span class="track"><span class="fill" style="width:${(v / max * 100).toFixed(1)}%"></span></span><span class="val">${nf(opt.d ?? 0).format(v * 100)} %</span></div>`).join("")
    : `<p class="muted">${esc(opt.empty || "Ingen data")}</p>`;
}
function topRows(o, n, other = "Resten") {
  const all = Object.entries(o).sort((a, b) => b[1] - a[1]);
  const rows = all.slice(0, n), rest = all.slice(n).reduce((a, x) => a + x[1], 0);
  if (rest > 0.005) rows.push([other, rest]);
  return rows;
}
const REGION = { "Eurosonen": "Eurosonen", "Europa ex. Euro": "Europa utenfor euro (inkl. Norden)", "Europe Emerging": "Øst-Europa", "Asia": "Asia, utviklet", "Asia Emerging": "Asia, fremvoksende" };

function mergedCompanies(list) {
  const m = new Map();
  for (const [id, w] of list) {
    const nm = PF.H.names[id]; if (!nm) continue;
    let key = cleanCompany(nm[0]);
    if (/^.{4,} [A-C]$/.test(key)) key = key.slice(0, -2);            // share classes: Alphabet A + Alphabet C
    const o = m.get(key) || { name: key, w: 0, cc: nm[1] };
    o.w += w; m.set(key, o);
  }
  return [...m.values()].sort((a, b) => b.w - a.w);
}

function renderOwn() {
  const res = PF.res, L = res.look, lead = $("own-lead");
  const noData = res.use.filter((u) => !holdingsOf(u.p.id));
  if (L.covered <= 0) {
    lead.innerHTML = '<p class="muted">Vi har ikke innholdet i disse fondene ennå.</p>';
    ["own-reg", "own-sec", "own-comp", "own-overlap"].forEach((id) => { $(id).innerHTML = ""; });
    return;
  }
  const ast = L.ast, eqShare = (ast.Aksjer || 0) / L.covered, bondShare = ((ast.Obligasjoner || 0) + (ast.Kontanter || 0)) / L.covered;
  const comps = mergedCompanies(L.companies), top10 = comps.slice(0, 10), top10w = top10.reduce((a, c) => a + c.w, 0);
  const us = top10.filter((c) => c.cc === "US").length;
  const regs = Object.entries(L.reg).sort((a, b) => b[1] - a[1]);
  const secs = Object.entries(L.sec).sort((a, b) => b[1] - a[1]);
  const parts = [];
  if (top10.length >= 5 && top10w >= 0.05) {
    parts.push(`<p class="big"><strong>${pc0(top10w)}</strong> av pengene dine ligger i de samme ${top10.length} ${us >= 8 ? "amerikanske " : ""}selskapene.</p>
      <p>Det er ${listNo(top10.slice(0, 5).map((c) => esc(c.name)))} med flere${us >= 5 && us < 8 ? ` – ${us} av de ${top10.length} er amerikanske` : ""}.
      ${top10w >= 0.25 ? "Går det dårlig for noen få av dem, merker du det godt." : "Det er vanlig for brede indeksfond; resten er spredt på svært mange selskaper."}</p>`);
  }
  const mix = [`<strong>${pc0(eqShare)}</strong> aksjer`];
  if (bondShare >= 0.005) mix.push(`<strong>${pc0(bondShare)}</strong> renter (obligasjoner og bankinnskudd)`);
  const oth = 1 - eqShare - bondShare; if (oth >= 0.01) mix.push(`${pc0(oth)} annet`);
  let s = `Porteføljen er ${listNo(mix)}.`;
  if (regs.length) s += ` Av aksjene er <strong>${pc0(regs[0][1])}</strong> i ${esc(REGION[regs[0][0]] || regs[0][0])}${regs[1] ? ` og ${pc0(regs[1][1])} i ${esc(REGION[regs[1][0]] || regs[1][0])}` : ""}.`;
  if (secs.length) s += ` Største bransje er ${esc(secs[0][0].toLowerCase())} med ${pc0(secs[0][1])}.`;
  parts.push(`<p>${s}</p>`);
  if (regs.length && regs[0][1] >= 0.6) parts.push(`<p class="hint">Mye i ett område: ${pc0(regs[0][1])} av aksjene avhenger av hvordan det går i ${esc(REGION[regs[0][0]] || regs[0][0])}.</p>`);
  if (noData.length) parts.push(`<p class="muted small-text">Mangler innhold for ${listNo(noData.map((u) => esc(u.p.name)))} (${pc0(1 - L.covered)} av porteføljen); de er ikke med i tallene over.</p>`);
  lead.innerHTML = parts.join("");

  bars("own-reg", topRows(L.reg, 6).map(([k, v]) => [REGION[k] || k, v]), { empty: "Ingen aksjer i porteføljen" });
  bars("own-sec", topRows(L.sec, 6), { empty: "Ingen aksjer i porteføljen" });
  bars("own-comp", top10.map((c) => [c.name, c.w]), { d: 1, empty: "Fant ingen enkeltselskaper (rentefond eier obligasjoner, ikke aksjer)" });
  $("own-comp-note").textContent = top10.length ? "Andel av hele porteføljen. Vi ser de 25–35 største i hvert fond, så tallene er minst så store." : "";

  renderTree(comps, eqShare, bondShare);

  // the same thing twice?
  const pairs = [];
  for (let i = 0; i < res.use.length; i++) for (let j = i + 1; j < res.use.length; j++) {
    const sim = I.similarity(holdingsOf(res.use[i].p.id), holdingsOf(res.use[j].p.id));
    if (sim && (ok(sim.reg) || ok(sim.top))) pairs.push({ a: res.use[i].p, b: res.use[j].p, s: sim.score });
  }
  pairs.sort((x, y) => y.s - x.s);
  const card = $("own-overlap-card");
  card.hidden = res.use.length < 2;
  const high = pairs.filter((x) => x.s >= 0.7);
  $("own-overlap").innerHTML = (high.length
    ? `<p><strong>Ja.</strong> ${high.length === 1 ? "To av fondene dine" : "Flere av fondene dine"} eier stort sett det samme. Du får ikke bedre spredning av å ha begge – behold det billigste.</p>`
    : "<p><strong>Nei.</strong> Fondene dine eier nokså forskjellige ting, så de utfyller hverandre.</p>") +
    pairs.slice(0, 8).map((x) => `<div class="bar-row pair"><span class="nm">${esc(x.a.name)} <span class="muted">og</span> ${esc(x.b.name)}</span>
      <span class="track"><span class="fill ${x.s >= 0.7 ? "warn" : ""}" style="width:${(x.s * 100).toFixed(0)}%"></span></span><span class="val">${pc0(x.s)} likt</span></div>`).join("");
}

/** Tile map of the whole portfolio: the largest companies, the rest of the shares, and interest. */
function renderTree(comps, eqShare, bondShare) {
  const top = comps.slice(0, 14), topSum = top.reduce((a, c) => a + c.w, 0);
  const labels = [], values = [], colors = [], text = [], ink = [];
  const add = (l, v, c, t, dark) => { if (v > 0.004) { labels.push(l); values.push(v * 100); colors.push(c); text.push(t || ""); ink.push(dark ? "#0b0b0b" : "#ffffff"); } };
  top.forEach((c) => add(c.name, c.w, css("--s1")));
  add("Resten av aksjene", Math.max(0, eqShare - topSum), css("--tile-rest"), "spredt på svært mange selskaper", css("--tile-rest") === "#86b6ef");
  add("Renter og kontanter", bondShare, css("--s2"), "obligasjoner og bankinnskudd");
  add("Annet", Math.max(0, 1 - eqShare - bondShare), css("--axis"));
  if (!labels.length || !window.Plotly) return;
  plot("chart-tree", [{ type: "treemap", labels, parents: labels.map(() => ""), values, text, branchvalues: "total",
    marker: { colors, line: { color: css("--surface"), width: 2 }, pad: { t: 0, l: 0, r: 0, b: 0 } }, tiling: { pad: 2, packing: "squarify" },
    texttemplate: "<b>%{label}</b><br>%{value:.1f} %", textfont: { color: ink, size: 13 }, textposition: "top left", sort: false,
    hovertemplate: "<b>%{label}</b><br>%{value:.1f} % av porteføljen<br>%{text}<extra></extra>" }],
  layout({ margin: { l: 0, r: 0, t: 0, b: 0 }, uniformtext: { minsize: 10, mode: "hide" } }));
}

// ---------------------------------------------------------------- 2. cheaper twins + 3. cost in kroner
function planValue(cost, gross = grossReturn()) { return I.savingsValue(PF.plan.start, PF.plan.monthly, PF.plan.years, gross, cost); }

function renderTwins() {
  const res = PF.res, yrs = PF.plan.years;
  const base = planValue(res.cost);
  $("twins").innerHTML = res.use.map((u, k) => {
    const tw = res.twins[k], p = u.p;
    const head = `<div class="twin-head"><div><strong>${esc(p.name)}</strong> <span class="tag">${esc(p.kindLabel)}</span></div>
      <div class="muted">${pc0(u.w)} av porteføljen · koster ${ok(p.cost) ? nf(2).format(p.cost) + " % per år" : "–"}</div></div>`;
    if (!tw.length) {
      const any = twinsOf(p.id, { all: true }).length;
      return `<div class="card twin">${head}<p class="okline">✓ ${any ? "Dette er allerede den billigste av tvillingene vi finner." : holdingsOf(p.id) || isRate(p) ? "Vi finner ingen billigere fond eller ETF-er med nesten samme innhold." : "Vi har ikke innholdet i dette fondet, så vi kan ikke lete etter tvillinger."}</p></div>`;
    }
    // the two cheapest, and always the cheapest ordinary fund (no brokerage fee) if there is one
    const show = tw.slice(0, 3), fund = tw.find((t) => t.p.kind === "fond");
    if (fund && !show.includes(fund)) show[2] = fund;
    const rows = show.map((t) => {
      const gain = planValue(res.cost - u.w * (p.cost - t.p.cost) / 100) - base;
      const d5 = ok(t.p.ret[5]) && ok(p.ret[5]) ? t.p.ret[5] - p.ret[5] : null;
      return `<tr><td class="wide">${t.p.url ? `<a href="${esc(t.p.url)}" target="_blank" rel="noopener">${esc(t.p.name)}</a>` : esc(t.p.name)}<br>
          <span class="tag">${esc(t.p.kindLabel)}</span> <span class="tag">${esc(t.label)}</span></td>
        <td class="num">${nf(2).format(t.p.cost)} %<br><span class="muted">mot ${nf(2).format(p.cost)} %</span></td>
        <td class="num save"><strong>${kr(gain)}</strong><br><span class="muted">mer etter ${yrs} år</span></td>
        <td class="num hide-narrow">${ok(t.p.ret[5]) ? pct(t.p.ret[5]) : '<span class="muted">under 5 år</span>'}${ok(d5) ? `<br><span class="muted">${pp(d5)} mot ditt</span>` : ""}</td>
        <td><button type="button" class="btn ghost" data-swap="${esc(p.id)}" data-with="${esc(t.p.id)}">Bytt</button></td></tr>`;
    }).join("");
    return `<div class="card twin">${head}<div class="table-scroll"><table class="data"><thead><tr><th>Billigere tvilling</th><th class="num">Kostnad per år</th>
      <th class="num">Du sitter igjen med</th><th class="num hide-narrow">Avkastning 5 år</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${tw.some((t) => t.p.kind === "etf") ? '<p class="muted small-text">ETF-er kjøpes på børs: kurtasje og kursforskjell kommer i tillegg. For små månedlige beløp er et fond ofte enklest.</p>' : ""}</div>`;
  }).join("");
}

function cheapestCost() {
  const res = PF.res;
  return res.use.reduce((a, u, k) => a + u.w * ((res.twins[k][0]?.p.cost ?? u.p.cost ?? 0)), 0) / 100;
}

function renderCost() {
  const res = PF.res, pl = PF.plan, g = grossReturn();
  const paid = pl.start + pl.monthly * 12 * pl.years;
  const v0 = planValue(0), v1 = planValue(res.cost), cheap = cheapestCost(), v2 = planValue(cheap);
  const hasTwin = v2 - v1 > 500;
  document.querySelectorAll(".yrs").forEach((e) => { e.textContent = pl.years; });
  const saving = [pl.start > 0 ? `${kr(pl.start)} i dag` : "", pl.monthly > 0 ? `${kr(pl.monthly)} i måneden` : ""].filter(Boolean).join(" og ");
  $("cost-lead").innerHTML = `<p class="big">Kostnadene tar <strong>${krRound(v0 - v1)}</strong> av sparingen din over ${pl.years} år.</p>
    <p>Med ${saving || "0 kr"} i ${pl.years} år og ${nf(1).format(g * 100)} % avkastning før kostnader blir det <strong>${krRound(v1)}</strong>
      med dagens kostnad på ${nf(2).format(res.cost * 100)} % per år. Helt uten kostnader ville det blitt ${krRound(v0)}.
      ${hasTwin ? `Bytter du til de billigste tvillingene (${nf(2).format(cheap * 100)} %), sitter du igjen med <strong>${krRound(v2 - v1)} mer</strong>.` : "Vi finner ingen billigere tvillinger – du betaler allerede lite for dette innholdet."}</p>`;

  const ys = Array.from({ length: pl.years + 1 }, (_, y) => y);
  const val = (cost) => ys.map((y) => I.savingsValue(pl.start, pl.monthly, y, g, cost));
  const c0 = val(0), c1 = val(res.cost), paidY = ys.map((y) => pl.start + pl.monthly * 12 * y);
  const line = (name, y, color, width, extra = {}) => ({ type: "scatter", mode: "lines", name, x: ys, y, line: { color, width }, hovertemplate: `${name}: %{y:,.0f} kr<extra></extra>`, ...extra });
  const end = (y, text) => ({ x: pl.years, y, text, showarrow: false, xanchor: "left", yanchor: "middle", xshift: 8, align: "left", font: { size: 11, color: css("--ink") } });
  plot("chart-cost", [
    line("Det du har satt inn", paidY, css("--axis"), 1.5),
    line("Porteføljen din", c1, css("--mine"), 2.5),
    line("Uten kostnader", c0, css("--bad"), 1.5, { fill: "tonexty", fillcolor: css("--bad-soft") }),
  ], layout({
    showlegend: false, hovermode: "x unified", margin: { l: 8, r: 128, t: 12, b: 40 },
    xaxis: axis({ ticksuffix: " år", dtick: pl.years > 12 ? 5 : pl.years > 5 ? 2 : 1, range: [0, pl.years], showgrid: false }),
    yaxis: axis({ tickformat: ",.0f", ticksuffix: " kr", nticks: 5, rangemode: "tozero" }),
    annotations: [end(v0, `Uten kostnader<br><b>${krRound(v0)}</b>`), end(v1 - (v0 - v1 < v0 * 0.06 ? v0 * 0.08 : 0), `Porteføljen din<br><b>${krRound(v1)}</b>`), end(paid, `Satt inn<br><b>${krRound(paid)}</b>`)],
  }));

  const drag = v0 - v1, wc = res.use.map((u) => u.w * (u.p.cost ?? 0)), sum = wc.reduce((a, b) => a + b, 0) || 1;
  table($("cost-table"), [{ t: "Fond / ETF" }, { t: "Andel", num: true }, { t: "Per år", num: true }, { t: "I år", num: true }, { t: `Over ${pl.years} år`, num: true }],
    [...res.use.map((u, k) => ({ cells: [u.p.name, pc0(u.w), ok(u.p.cost) ? nf(2).format(u.p.cost) + " %" : "–", kr(pl.start * u.w * (u.p.cost ?? 0) / 100), krRound(drag * wc[k] / sum)] })),
      { _cls: "total", cells: ["Sum", "100 %", nf(2).format(res.cost * 100) + " %", kr(pl.start * res.cost), krRound(drag)] }]);
  $("cost-note").textContent = "«Over årene» er hvor mye mindre du sitter igjen med enn om fondene var gratis: både det du betaler og avkastningen du går glipp av på de pengene. " +
    "Fond: Nordnets totalkostnad (forvaltning − returprovisjon + plattformavgift). ETF-er: årlig kostnad (TER); kurtasje og valutapåslag ved kjøp kommer i tillegg.";
}

// ---------------------------------------------------------------- 4. risk as a story
function renderRisk() {
  const res = PF.res, st = res.story, lead = $("risk-lead");
  if (!st) {
    lead.innerHTML = `<p class="muted">${res.missing.length ? `Mangler kursdata for ${listNo(res.missing.map((u) => esc(u.p.name)))}.` : "For kort felles historikk til å fortelle noe om risiko."}</p>`;
    $("risk-kpis").innerHTML = ""; emptyChart("chart-risk", "Ingen historikk å vise"); emptyChart("chart-years", "Ingen historikk å vise"); $("risk-contrib").innerHTML = "";
    return;
  }
  const f = st.fall, K = 100000;
  const back = f.recovered !== null
    ? `Det tok <strong>${duration(f.monthsBack)}</strong> fra bunnen før pengene var tilbake (${mName(f.recovered)}).`
    : `Porteføljen er <strong>ennå ikke tilbake</strong> – ${duration(f.monthsSinceTrough)} etter bunnen.`;
  const est = res.use.filter((u) => u.ser.kind !== "own");
  const years = res.months / 12;
  lead.innerHTML = `<p class="big">I det verste året ville 100 000 kr blitt til <strong>${krRound(K * (1 + st.worst.ret))}</strong>.</p>
    <p>Det var fra ${mName(st.worst.from)} til ${mName(st.worst.to)} (${pct(st.worst.ret, 0)}).
      Det største fallet gikk fra toppen i ${mName(f.peak)} til bunnen i ${mName(f.trough)}: da ble 100 000 kr til ${krRound(K * (1 + f.depth))}. ${back}</p>
    <p>I et vanlig år har porteføljen gitt rundt ${pct(st.median, 0)}, og ${nf(0).format(Math.round(st.negShare * 10))} av 10 tolvmånedersperioder har endt i minus.
      Det beste året ga ${pct(st.best.ret, 0)}.</p>
    <p class="muted small-text">Bygger på ${nf(0).format(Math.floor(years))} år (${mName(res.from)}–${mName(D.end)}) med fast fordeling, i kroner, etter fondenes kostnader.
      ${years < 12 ? "Perioden er kort; over lengre tid må du regne med verre år enn dette. " : ""}
      ${est.length ? `Fond har ikke kurshistorikk hos oss: for ${listNo(est.map((u) => esc(u.p.name)))} er månedene anslått ut fra markedet fondet investerer i, justert til fondets egen avkastning og risiko. ` : ""}
      Historien gjentar seg ikke nøyaktig.</p>`;

  const dates = [], vals = [];
  for (let k = 0; k <= res.months; k++) { dates.push(monthEnd(res.from - 1 + k)); vals.push(st.values[k] * K); }
  const b = benchSeries(), traces = [];
  if (b && E.isNum(b[res.from])) {
    const bv = E.cumulative(b, res.from, D.end, K);
    traces.push({ x: dates, y: bv, mode: "lines", name: `Verdensindeksen (${D.by[st_bench()]?.ticker || "referanse"})`, line: { color: css("--axis"), width: 1.5 }, hovertemplate: "%{y:,.0f} kr<extra>Verdensindeksen</extra>" });
  }
  traces.push({ x: dates, y: vals, mode: "lines", name: "Porteføljen din", line: { color: css("--mine"), width: 2.5 }, hovertemplate: "%{y:,.0f} kr<extra>Porteføljen din</extra>" });
  const d = (i) => monthEnd(i), endX = f.recovered !== null ? d(f.recovered) : dates[dates.length - 1];
  const useLog = Math.max(...vals) / Math.min(...vals) > 5;
  const vAt = (i) => st.values[i - res.from + 1] * K;
  plot("chart-risk", traces, layout({
    hovermode: "x unified", margin: { l: 72, r: 16, t: 36, b: 40 },
    xaxis: axis({ type: "date", tickformat: "%Y", range: [dates[0], dates[dates.length - 1]] }),
    yaxis: axis({ tickformat: ",.0f", ticksuffix: " kr", type: useLog ? "log" : "linear" }),
    shapes: [{ type: "rect", xref: "x", yref: "paper", x0: d(f.peak), x1: endX, y0: 0, y1: 1, fillcolor: css("--bad"), opacity: 0.1, line: { width: 0 } }],
    annotations: [
      { x: d(f.trough), y: useLog ? Math.log10(vAt(f.trough)) : vAt(f.trough), text: `Bunn ${mName(f.trough)}<br><b>${pct(f.depth, 0)}</b>`, showarrow: true, arrowhead: 0, ax: 0, ay: 34, font: { size: 11, color: css("--ink") } },
      { x: d(f.peak), y: 1, yref: "paper", text: `Største fall${f.recovered !== null ? ` – tilbake etter ${duration(f.monthsDown + f.monthsBack)}` : " – ikke tilbake ennå"}`, showarrow: false, xanchor: "left", yanchor: "bottom", font: { size: 11, color: css("--ink-2") } },
    ],
  }));
  $("risk-chart-note").textContent = "Det røde feltet er perioden fra toppen før det største fallet til pengene var tilbake.";
  $("risk-kpis").innerHTML = [
    kpi("Verste år", pct(st.worst.ret, 0), `${mName(st.worst.from)}–${mName(st.worst.to)}`),
    kpi("Største fall", pct(f.depth, 0), `${mName(f.peak)}–${mName(f.trough)} (${duration(f.monthsDown)})`),
    kpi("Tid tilbake", f.recovered !== null ? duration(f.monthsBack) : "ikke tilbake", "fra bunnen til gammel topp"),
    kpi("Et dårlig år", pc0(st.bad), "ett av ti år har vært verre"),
    kpi("Et vanlig år", pct(st.median, 0), "midterste tolvmånedersperiode"),
    kpi("Beste år", pct(st.best.ret, 0), `${mName(st.best.from)}–${mName(st.best.to)}`),
  ].join("");
  renderRiskExtras();
}
function st_bench() { return st.bench; }

function renderRiskExtras() {
  const res = PF.res;
  // calendar years
  const yrs = [];
  let cur = null;
  for (let t = res.from; t <= D.end; t++) {
    const { y } = monthYM(t);
    if (!cur || cur.y !== y) { cur = { y, g: 1, n: 0 }; yrs.push(cur); }
    cur.g *= 1 + res.r[t]; cur.n++;
  }
  const v = yrs.map((x) => (x.g - 1) * 100), lo = Math.min(...v), hi = Math.max(...v);
  plot("chart-years", [{ type: "bar", x: yrs.map((x) => String(x.y)), y: v, marker: { color: v.map((x) => (x >= 0 ? css("--good") : css("--bad"))), line: { width: 0 } },
    customdata: yrs.map((x) => (x.n < 12 ? ` (${x.n} måneder)` : "")), hovertemplate: "%{x}%{customdata}: %{y:.1f} %<extra></extra>",
    text: v.map((x) => (x === lo || x === hi ? `${x >= 0 ? "+" : "−"}${nf(0).format(Math.abs(x))} %` : "")), textposition: "outside", textfont: { size: 11, color: css("--ink") }, constraintext: "none", cliponaxis: false }],
  layout({ showlegend: false, bargap: 0.25, margin: { l: 44, r: 8, t: 20, b: 32 },
    xaxis: axis({ type: "category", showgrid: false, tickangle: 0, nticks: 8 }), yaxis: axis({ ticksuffix: " %", zeroline: true, zerolinewidth: 1 }) }));
  // money vs swings
  const rc = res.model?.rc, box = $("risk-contrib");
  if (!rc) { box.innerHTML = '<p class="muted">For kort historikk.</p>'; return; }
  const mx = Math.max(...rc, ...res.use.map((u) => u.w), 1e-9);
  const big = res.use.map((u, k) => ({ u, d: rc[k] - u.w })).sort((a, b) => b.d - a.d)[0];
  box.innerHTML = res.use.map((u, k) => `<div class="contrib-row"><div class="nm">${swatch(u.item)}${esc(u.p.name)}</div>
      <div class="pair"><span class="lbl">Penger</span><span class="track"><span class="fill money" style="width:${(u.w / mx * 100).toFixed(1)}%"></span></span><span class="val">${pc0(u.w)}</span></div>
      <div class="pair"><span class="lbl">Risiko</span><span class="track"><span class="fill" style="width:${(Math.max(0, rc[k]) / mx * 100).toFixed(1)}%;background:${colorOf(u.item)}"></span></span><span class="val">${pc0(rc[k])}</span></div></div>`).join("") +
    (big && big.d > 0.05 ? `<p class="hint">${esc(big.u.p.name)} er ${pc0(big.u.w)} av pengene, men står for ${pc0(rc[res.use.indexOf(big.u)])} av svingningene.</p>` : "");
}

// ---------------------------------------------------------------- what can it become
function renderOutcomes() {
  const res = PF.res, m = res.model, pl = PF.plan, lead = $("fan-lead");
  if (!m) { lead.innerHTML = '<p class="muted">For kort historikk til å anslå utfall.</p>'; emptyChart("chart-fan", "Ingen anslag å vise"); $("fan-note").textContent = ""; return; }
  const pr = I.projection(pl.start, pl.monthly, pl.years, m.now.ret, m.now.vol, 4000), n = pl.years, ys = pr.paid.map((_, y) => y);
  lead.innerHTML = `<p class="big">Om ${n} år er sparingen mest sannsynlig verdt rundt <strong>${krRound(pr.p50[n])}</strong>.</p>
    <p>Går det dårlig (ett av ti utfall) ender du på ${krRound(pr.p10[n])} eller mindre. Går det bra (ett av ti) blir det ${krRound(pr.p90[n])} eller mer.
      Du har da satt inn ${krRound(pr.paid[n])}${pr.p10[n] < pr.paid[n] ? " – i de dårlige utfallene sitter du altså igjen med mindre enn du satte inn" : ""}.</p>`;
  const end = (y, text) => ({ x: n, y, text, showarrow: false, xanchor: "left", yanchor: "middle", xshift: 8, align: "left", font: { size: 11, color: css("--ink") } });
  const tr = (name, y, color, width, extra = {}) => ({ type: "scatter", mode: "lines", name, x: ys, y, line: { color, width }, hovertemplate: `${name}: %{y:,.0f} kr<extra></extra>`, ...extra });
  plot("chart-fan", [
    tr("Går det dårlig (1 av 10)", pr.p10, css("--mine"), 1),
    tr("Går det bra (1 av 10)", pr.p90, css("--mine"), 1, { fill: "tonexty", fillcolor: css("--band") }),
    tr("Mest sannsynlig", pr.p50, css("--mine"), 3),
    tr("Det du har satt inn", pr.paid, css("--axis"), 1.5),
  ], layout({
    showlegend: false, hovermode: "x unified", margin: { l: 8, r: 150, t: 12, b: 40 },
    xaxis: axis({ ticksuffix: " år", dtick: n > 12 ? 5 : n > 5 ? 2 : 1, range: [0, n], showgrid: false }),
    yaxis: axis({ tickformat: ",.0f", ticksuffix: " kr", nticks: 6, rangemode: "tozero" }),
    annotations: [end(pr.p90[n], `Går det bra<br><b>${krRound(pr.p90[n])}</b>`), end(pr.p50[n], `Mest sannsynlig<br><b>${krRound(pr.p50[n])}</b>`),
      end(Math.min(pr.p10[n], pr.p50[n] - (pr.p90[n] - pr.p10[n]) * 0.13), `Går det dårlig<br><b>${krRound(pr.p10[n])}</b>`)],
  }));
  $("fan-note").textContent = `Det blå feltet dekker 8 av 10 utfall. Anslag fra forventet avkastning ${pct(m.now.ret)} og svingninger ${pct(m.now.vol)} per år, etter kostnader, i dagens kroneverdi uten justering for prisvekst.`;
}

// ---------------------------------------------------------------- 5. a better mix
function suggestion() {
  const res = PF.res, m = res?.model;
  if (!m?.frontier) return null;
  const pts = m.frontier, lo = pts[0].vol, hi = Math.max(...pts.map((p) => p.vol));
  const cur = Math.max(lo, Math.min(hi, m.now.vol));
  const target = PF.risk === "same" || !ok(PF.risk) ? cur : lo + (hi - lo) * PF.risk / 100;
  const raw = I.forRisk(pts, target);
  // whole percent, like the table above
  const fl = Array.from(raw, (x) => Math.floor(x * 100)), rest = 100 - fl.reduce((a, b) => a + b, 0);
  Array.from(raw, (x, i) => [x * 100 - fl[i], i]).sort((a, b) => b[0] - a[0]).slice(0, rest).forEach(([, i]) => { fl[i] += 1; });
  const w = Float64Array.from(fl, (x) => x / 100);
  return { w, perf: m.perf(w), lo, hi, cur, target, pos: hi > lo ? Math.round((target - lo) / (hi - lo) * 100) : 50,
    story: I.riskStory(res.mix(w), res.from, D.end) };
}

function renderSuggestion() {
  const res = PF.res, m = res.model, lead = $("sg-lead"), sl = $("sg-risk");
  const sg = res.sg = suggestion();
  const off = (msg) => { lead.innerHTML = msg; $("sg-table").innerHTML = ""; $("sg-bars").innerHTML = ""; sl.disabled = true; $("sg-apply").disabled = true; $("sg-same").disabled = true; };
  if (!sg) return off(res.use.length < 2 ? "Legg til minst to fond eller ETF-er, så foreslår vi hvordan pengene bør fordeles mellom dem."
    : "Vi mangler historikk for å kunne foreslå en fordeling for disse fondene.");
  sl.disabled = false; $("sg-same").disabled = PF.risk === "same"; sl.value = sg.pos;
  const now = m.now, d = sg.perf.ret - now.ret, dv = sg.perf.vol - now.vol;
  const changed = res.use.some((u, k) => Math.abs(sg.w[k] - u.w) >= 0.015);
  $("sg-apply").disabled = !changed;
  const gainKr = planValue(0, sg.perf.ret) - planValue(0, now.ret);
  const riskTxt = Math.abs(dv) < 0.004 ? "med samme risiko som i dag" : dv < 0 ? `med lavere risiko enn i dag (svingninger ${pct(sg.perf.vol)} mot ${pct(now.vol)})` : `med høyere risiko enn i dag (svingninger ${pct(sg.perf.vol)} mot ${pct(now.vol)})`;
  lead.innerHTML = !changed
    ? "<strong>Fordelingen din er allerede omtrent så god som den kan bli</strong> med disse fondene og denne risikoen. Vil du ha mer eller mindre risiko, dra i glideren."
    : `<strong>Forslag ${riskTxt}:</strong> forventet avkastning ${d >= 0 ? "øker" : "går ned"} fra ${pct(now.ret)} til <strong>${pct(sg.perf.ret)}</strong> per år` +
      (Math.abs(gainKr) >= 1000 ? ` – omtrent <strong>${krRound(Math.abs(gainKr))} ${gainKr >= 0 ? "mer" : "mindre"}</strong> etter ${PF.plan.years} år` : "") +
      `. Verste år i historikken: ${pc0(sg.story?.worst.ret)} (i dag ${pc0(res.story.worst.ret)}).` +
      (res.capped?.length ? ` <span class="muted">Smale fond (${listNo(res.capped.map(esc))}) får aldri mer enn ${pc0(NARROW_CAP)} hver i forslaget – ett fond som har gått bra, skal ikke få dominere.</span>` : "");
  $("sg-bars").innerHTML = '<div class="ba-row"><span>I dag</span><div class="mixbar" id="sg-bar-now"></div></div><div class="ba-row"><span>Forslag</span><div class="mixbar" id="sg-bar-new"></div></div>';
  mixbar("sg-bar-now", res.use.map((u) => ({ label: u.p.name, w: u.w, color: colorOf(u.item) })));
  mixbar("sg-bar-new", res.use.map((u, k) => ({ label: u.p.name, w: sg.w[k], color: colorOf(u.item) })));
  const row = (label, a, b, cls) => ({ _cls: cls || "", cells: [label, a, b, ""] });
  table($("sg-table"), [{ t: "Fond / ETF" }, { t: "I dag", num: true }, { t: "Forslag", num: true }, { t: "Endring", num: true }], [
    ...res.use.map((u, k) => { const dd = sg.w[k] - u.w; return { cells: [{ html: swatch(u.item) + esc(u.p.name) }, pc0(u.w), { html: `<strong>${pc0(sg.w[k])}</strong>` },
      { html: Math.abs(dd) < 0.005 ? '<span class="muted">uendret</span>' : `<span class="${dd > 0 ? "delta-pos" : "delta-neg"}">${dd > 0 ? "+" : "−"}${nf(0).format(Math.abs(dd) * 100)} pp · ${dd > 0 ? "kjøp" : "selg"} ${kr(Math.abs(dd) * PF.plan.start)}</span>` }] }; }),
    row("Forventet avkastning per år", pct(now.ret), pct(sg.perf.ret), "total"),
    row("Svingninger per år", pct(now.vol), pct(sg.perf.vol)),
    row("Et dårlig år (ett av ti er verre)", pc0(res.story.bad), pc0(sg.story?.bad)),
    row("Verste år i historikken", pct(res.story.worst.ret, 0), pct(sg.story?.worst.ret, 0)),
    row("Avkastning for risikoen (Sharpe)", `${nf(2).format(now.sharpe)} – ${sharpeWord(now.sharpe)}`, `${nf(2).format(sg.perf.sharpe)} – ${sharpeWord(sg.perf.sharpe)}`),
  ]);
}

function renderMap() {
  const res = PF.res, m = res?.model;
  if (!m) { emptyChart("chart-map", "For kort historikk til å vise risiko og avkastning"); $("map-note").textContent = ""; return; }
  const sg = res.sg, rfP = m.rf * 100;
  const hx = res.use.map((u, k) => Math.sqrt(m.est.S[k][k]) * 100), hy = Array.from(m.mu, (v) => v * 100);
  const xs = [...hx, m.now.vol * 100], ys = [...hy, m.now.ret * 100];
  const bm = benchSeries(), def = D.summary.defaults;
  const bVol = Math.sqrt(m.est.benchVar) * 100, bRet = ((1 - def.history_weight) * (m.rf + def.market_risk_premium - (D.by[st.bench]?.fee ?? 0) / 100) + def.history_weight * m.est.benchHist) * 100;
  if (bm) { xs.push(bVol); ys.push(bRet); }
  const bg = sharpeBackdrop(xs, ys, rfP);
  const short = (s) => (s.length > 24 ? s.slice(0, 22) + "…" : s);
  const traces = [...bg.traces];
  if (m.frontier) traces.push({ type: "scatter", mode: "lines", name: "Beste blandinger av fondene dine", x: m.frontier.map((p) => p.vol * 100), y: m.frontier.map((p) => p.ret * 100),
    line: { color: css("--ink"), width: 2 }, hoverinfo: "skip" });
  const order = hx.map((x, k) => [x, k]).sort((a, b) => a[0] - b[0]).map((x) => x[1]), pos = [];
  order.forEach((k, i) => { pos[k] = i % 2 ? "bottom center" : "top center"; });
  traces.push({ type: "scatter", mode: "markers+text", name: "Fondene dine", x: hx, y: hy, text: res.use.map((u) => esc(short(u.p.name))), textposition: pos,
    textfont: { size: 11, color: css("--ink") }, marker: { size: 10, color: css("--ink"), line: { color: css("--surface"), width: 1.5 } },
    customdata: res.use.map((u) => u.p.name), hovertemplate: "<b>%{customdata}</b><br>Forventet %{y:.1f} % per år · svingninger %{x:.1f} %<extra></extra>" });
  if (bm) traces.push({ type: "scatter", mode: "markers+text", name: "Verdensindeksen", x: [bVol], y: [bRet], text: ["Verdensindeksen"], textposition: "middle right", textfont: { size: 11, color: css("--ink-2") },
    marker: { size: 11, symbol: "circle-open", color: css("--ink"), line: { width: 2 } }, hovertemplate: `<b>${esc(D.by[st.bench]?.name || "Referanse")}</b><br>Forventet %{y:.1f} % · svingninger %{x:.1f} %<extra></extra>` });
  traces.push({ type: "scatter", mode: "markers+text", name: "Porteføljen i dag", x: [m.now.vol * 100], y: [m.now.ret * 100], text: ["<b>I dag</b>"], textposition: "middle right",
    textfont: { size: 12, color: css("--ink") }, marker: { size: 20, symbol: "star", color: css("--mine"), line: { color: css("--surface"), width: 2 } },
    hovertemplate: "<b>Porteføljen i dag</b><br>Forventet %{y:.1f} % per år · svingninger %{x:.1f} %<extra></extra>" });
  if (sg && res.use.some((u, k) => Math.abs(sg.w[k] - u.w) >= 0.015)) traces.push({ type: "scatter", mode: "markers+text", name: "Forslaget", x: [sg.perf.vol * 100], y: [sg.perf.ret * 100],
    text: ["<b>Forslag</b>"], textposition: "middle left", textfont: { size: 12, color: css("--ink") }, marker: { size: 20, symbol: "star", color: css("--surface"), line: { color: css("--ink"), width: 2 } },
    hovertemplate: "<b>Forslaget</b><br>Forventet %{y:.1f} % per år · svingninger %{x:.1f} %<extra></extra>" });
  plot("chart-map", traces, layout({
    hovermode: "closest", annotations: bg.annotations, margin: { l: 60, r: 16, t: 40, b: 52 },
    xaxis: axis({ ticksuffix: " %", titleText: "Svingninger per år (risiko)", range: bg.xr, showgrid: false }),
    yaxis: axis({ ticksuffix: " %", titleText: "Forventet avkastning per år, etter kostnader", range: bg.yr, showgrid: false }),
  }));
  $("map-note").textContent = `${SHARPE_HINT} Streken viser det beste du kan få ut av akkurat disse fondene ved å endre andelene. Tallene er anslag fremover, ikke historikk.`;
}

// ---------------------------------------------------------------- method
function renderPfMethod() {
  const def = D.summary.defaults, H = PF.H;
  $("pf-method").innerHTML = `
    <h3>Hva eier jeg egentlig?</h3>
    <p>For hvert fond og hver ETF henter vi fordelingen på land, bransjer og aktivaklasser og de 25–35 største beholdningene fra Nordnet (Morningstar-data${H.fetched ? `, hentet ${dateNo(H.fetched)}` : ""}; ${num(H.n || 0)} fond og ETF-er).
      Tallene vektes med andelene dine og legges sammen. Selskapene er bare de største i hvert fond, så andelen i enkeltselskaper er et minimum. Land og bransjer gjelder aksjedelen.</p>
    <h3>Tvillinger</h3>
    <p>To fond regnes som tvillinger når de har minst ${pc0(TWIN.reg)} felles landfordeling, ${pc0(TWIN.sec)} felles bransjefordeling og de største beholdningene overlapper minst ${pc0(TWIN.top)},
      samme aktivaklasse og samme valutasikring. ETF-er som følger samme indeks (tracking error under ${pct(D.summary.te_threshold, 1)}) er alltid tvillinger. Rentefond sammenlignes på type, valuta og svingninger.
      Ligger fondet ditt på aksjesparekonto, foreslås bare tvillinger som også kan ligge der. «Likt» betyr likt innhold i dag – et aktivt fond kan endre seg.</p>
    <h3>Kostnad i kroner</h3>
    <p>Innskudd i starten av hver måned, årlig avkastning før kostnader minus kostnaden, månedlig rentes rente. Eksempel: 1 000 kr i måneden i 20 år med 7 % gir
      ${krRound(I.savingsValue(0, 1000, 20, 0.07, 0.002))} med 0,2 % i kostnad og ${krRound(I.savingsValue(0, 1000, 20, 0.07, 0.015))} med 1,5 %. Står avkastningsfeltet tomt, brukes anslaget for porteføljen din.</p>
    <h3>Risiko</h3>
    <p>Porteføljen regnes måned for måned i kroner med fast fordeling, så langt tilbake som alle delene har historikk. «Verste år» er den dårligste tolvmånedersperioden, «et dårlig år» er nivået ett av ti år har vært verre enn.
      ETF-er bruker egne kurser (og en ETF på samme indeks for årene før de startet). <strong>Fond har vi ikke kurshistorikk for.</strong> Der låner vi månedssvingningene fra den ETF-en som eier mest det samme,
      skalerer dem til fondets egen risiko og forskyver dem så de siste årene gir nøyaktig fondets egen avkastning (Nordnets tall). Norske rentefond anslås fra styringsrenten pluss fondets egen meravkastning og risiko; rentefond som svinger mer enn ${pct(CREDIT.vol)} i året
      (kreditt- og høyrentefond) antas å følge aksjemarkedet et stykke på vei (korrelasjon ${nf(1).format(CREDIT.corr)}), fordi de faller sammen med aksjer i kriser.
      Slike fond er merket «historikk anslått».</p>
    <h3>Den anbefalte porteføljen</h3>
    <p>Oppskriften er fast: aksjedelen deles ${pc0(RECO.core)} i et globalt indeksfond, ${pc0(RECO.em)} i fremvoksende markeder og ${pc0(RECO.small)} i små selskaper globalt; resten i et pengemarkedsfond i kroner.
      Aksjeandelen følger sparetiden (til og med 2 år: 20 %, 5 år: 40 %, 9 år: 60 %, lenger: 80 %) og kan overstyres. Fondene velges på nytt fra dataene hver måned: indeksfond i kroner med minst 1 000 eiere hos Nordnet
      og kostnad innenfor 0,15 prosentpoeng av det billigste; blant dem som ligger innenfor et halvt prosentpoeng av beste femårsavkastning (de følger markedet sitt godt), det billigste.
      Dette er en generell oppskrift, ikke personlig rådgivning – den kjenner ikke gjelden, bufferen eller skatten din.</p>
    <h3>Hva kan sparingen bli verdt?</h3>
    <p>4 000 simulerte forløp med månedlig avkastning trukket fra porteføljens forventede avkastning og svingninger (lognormal, uavhengige måneder). Feltet viser 10.–90. persentil, streken medianen.
      Virkelige markeder har flere ekstreme måneder enn modellen, og tallene er ikke justert for prisvekst.</p>
    <h3>Forventet avkastning og forslaget</h3>
    <p>Forventet avkastning = ${pc0(1 - def.history_weight)} likevekt (risikofri rente ${pct(D.summary.rf_now)} + fondets følsomhet for verdensindeksen × ${pct(def.market_risk_premium)} risikopremie − kostnad)
      + ${pc0(def.history_weight)} historisk snitt de siste ${def.estimation_years} årene. Samvariasjonen mellom fondene er fra samme periode (Ledoit-Wolf-krymping).
      Forslaget er den blandingen av fondene dine som gir høyest forventet avkastning for risikoen du velger. Smale fond (aktive fond, bransje-, tema- og enkeltlandsfond,
      rentefond med høy risiko) får aldri mer enn ${pc0(NARROW_CAP)} hver; brede indeksfond, kombinasjonsfond og trygge rentefond har ingen grense. Sharpe = (avkastning − risikofri rente) / svingninger.
      Dette er anslag med stor usikkerhet – bruk forslaget som et utgangspunkt, ikke en fasit.</p>
    <p class="muted">Modellverktøy, ikke finansiell rådgivning. Historisk avkastning er ingen garanti for fremtidig avkastning.</p>`;
}

document.addEventListener("DOMContentLoaded", setupPortfolio);
