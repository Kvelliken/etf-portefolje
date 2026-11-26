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
const MAX_ITEMS = 8;            // the builder holds at most this many funds and ETFs
const ETF_FX = 0.0025;          // Nordnet: automatic currency exchange on each ETF purchase in a foreign currency (prisliste, 2026)
const EM_WORLD = 0.03;          // a global fund with at least this share of its shares in emerging markets also covers that role
const EM_REGIONS = ["Asia Emerging", "Latin-Amerika", "Europe Emerging", "Afrika", "Midtøsten"];
const NORDIC_CC = new Set(["NO", "SE", "DK", "FI", "IS"]);
const PF = {
  ready: false, items: [], plan: { start: 100000, monthly: 1000, years: 20, ret: null }, risk: "same",
  recipe: "blocks", nordic: false,
  H: { items: {}, names: {} }, U: {}, S: {}, X: {}, cand: null, res: null,
};

// ---------------------------------------------------------------- small helpers
const mName = (i) => { const { y, m } = monthYM(i); return `${MONTHS[m - 1]} ${y}`; };
const krRound = (x) => (ok(x) ? nf(0).format(Math.round(x / 1000) * 1000) + "\u00a0kr" : "–");
const pc0 = (x) => (ok(x) ? nf(0).format(Math.round(x * 100) || 0) + "\u00a0%" : "–");
function duration(months) {
  const y = Math.floor(months / 12), m = months % 12;
  const ys = y ? `${y} år` : "", ms = m ? `${m} ${m === 1 ? "måned" : "måneder"}` : "";
  return ys && ms ? `${ys} og ${ms}` : ys || ms || "under én måned";
}
function listNo(a) { return a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} og ${a[a.length - 1]}`; }
const cleanCompany = (s) => String(s || "").replace(/,?\s+(class|cl\.?|ser\.?|series)\s+[a-c]\b\.?/i, "").replace(/\s+(inc\.?|corp\.?|corporation|plc|ltd\.?|asa|ab|a\/s|oyj|n\.v\.|se|ag)\.?$/i, "").replace(/[,.\s]+$/, "").trim();

// ---------------------------------------------------------------- colour per fund (follows the fund, never its rank)
const SLOTS = 4;                                  // chart-1 … chart-4; more funds share "Øvrige" in the stripes
function assignColors() {
  const used = new Set(PF.items.map((x) => x.c).filter((c) => Number.isInteger(c) && c < SLOTS));
  for (const it of PF.items) {
    if (Number.isInteger(it.c) && it.c < SLOTS) continue;
    let k = 0; while (used.has(k) && k < SLOTS) k++;
    it.c = k; used.add(k);                       // past four funds: neutral
  }
}
const tokOf = (it) => (it && Number.isInteger(it.c) && it.c < SLOTS ? `--chart-${it.c + 1}` : "--chart-context");
const colorOf = (it) => css(tokOf(it));
const swatch = (it) => `<span class="swatch" style="background:${colorOf(it)}"></span>`;
/** Segmented 100 % bar. parts = [{label, w (0..1), tok (colour token)}]; parts in the neutral colour are merged into "Øvrige". */
function mixbar(el, parts) {
  const p = parts.filter((x) => x.w > 0.002 && x.tok !== "--chart-context");
  const rest = parts.filter((x) => x.w > 0.002 && x.tok === "--chart-context");
  if (rest.length === 1) p.push(rest[0]);
  else if (rest.length > 1) p.push({ label: `Øvrige (${rest.length})`, w: rest.reduce((a, x) => a + x.w, 0), tok: "--chart-context" });
  const box = typeof el === "string" ? $(el) : el;
  box.innerHTML = p.map((x) => `<span class="seg" style="flex:${(x.w * 100).toFixed(2)} 0 0;background:${css(x.tok)};color:${inkOn(x.tok)}" title="${esc(x.label)}: ${pc0(x.w)}">${x.w >= 0.11 ? `<b>${pc0(x.w)}</b>` : ""}</span>`).join("");
  box.setAttribute("aria-label", p.map((x) => `${x.label} ${pc0(x.w)}`).join(", "));
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
      region: e.region, sector: e.sector, theme: e.theme, style: e.style, esg: !!e.esg,
      acc: e.acc, yield12: e.yield12 ?? null, divMissing: !!e.div_missing, divFix: e.div_fix || null,
      ret: { 1: e.m?.[1]?.ret, 3: e.m?.[3]?.ret, 5: e.m?.[5]?.ret, 10: e.m?.[10]?.ret }, vol: e.m?.[5]?.vol ?? e.m?.[3]?.vol ?? e.m?.[1]?.vol,
      kindLabel: isRate(e) ? "Rente-ETF" : "ETF" };
  } else if (f) {
    p = { id, kind: "fond", name: f.name, ticker: "", url: f.url, cost: f.cost, asset_class: f.asset_class, category: f.category,
      index: !!f.index, ask: !!f.ask, hedged: !!f.hedged, leveraged: false, owners: f.owners, cluster: null, currency: f.currency,
      tradable: f.tradable !== false, ret: { 1: f.r1, 3: f.r3, 5: f.r5, 10: f.r10 }, vol: f.vol5 ?? f.vol3 ?? f.vol1,
      region: f.region, sector: f.sector, theme: f.theme, style: f.style, esg: !!f.esg,
      acc: f.acc, yield12: null, divMissing: false, divFix: null,
      kindLabel: isRate(f) ? "Rentefond" : f.index ? "Indeksfond" : f.asset_class === "Blandet" ? "Kombinasjonsfond" : "Aktivt fond" };
  }
  if (p) PF.U[id] = p;
  return p;
}
/** Holdings record of a fund or ETF. A fund of funds lists other funds among its largest holdings; those are
 *  replaced by what the underlying funds own, so «Hva eier jeg?» shows companies and twins compare like with like. */
function holdingsOf(id) {
  const h = PF.H.items[id];
  if (!h) return null;
  if (PF.X[id]) return PF.X[id];
  let out = h;
  const map = fundNameIndex(), top = [];
  let swapped = false;
  for (const [hid, w] of h.top || []) {
    const sub = map.get(normFundName(PF.H.names[hid]?.[0]));
    const sh = sub && sub !== id ? PF.H.items[sub] : null;
    if (sh?.top?.length) { swapped = true; for (const [cid, cw] of sh.top) top.push([cid, w * cw / 100]); } else top.push([hid, w]);
  }
  if (swapped) {
    const m = new Map();
    for (const [cid, w] of top) m.set(cid, (m.get(cid) || 0) + w);
    out = { ...h, top: [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60) };
  }
  PF.X[id] = out;
  return out;
}
/** Fund name without share class, currency and accumulation words, for matching a holding to a fund. */
function normFundName(s) {
  if (!s) return "";
  let t = ` ${String(s).toLowerCase().replace(/\(.*?\)/g, " ")} `;
  for (let k = 0; k < 3; k++) t = t.replace(/\s(a|b|c|d|e|n|s|r|i|u|p|p3|a1|a2|b1|w|acc|dist|nok|eur|usd|sek|1c|1d)(?=\s)/g, " ");
  return t.replace(/[^a-z0-9æøå]+/g, " ").trim();
}
function fundNameIndex() {
  if (PF.nameIdx) return PF.nameIdx;
  const m = new Map();
  for (const x of [...FS.list, ...D.list]) {
    if (!PF.H.items[x.isin]) continue;
    const k = normFundName(x.name);
    if (k.split(" ").length >= 2 && !m.has(k)) m.set(k, x.isin);
  }
  PF.nameIdx = m;
  return m;
}
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

// ---------------------------------------------------------------- roles
/** Each fund or ETF fills one role. The builder groups the portfolio by role, and «Bytt» offers funds in the same role. */
const ROLE = {
  core: { name: "Global kjerne", text: "Brede indeksfond for hele verden eller de rike landene.", words: "global verden world acwi all world" },
  nordic: { name: "Norge og Norden", text: "Selskaper på børsene i Norge, Sverige, Danmark og Finland.", words: "norge norden nordic norway nordisk oslo" },
  region: { name: "Enkeltregioner", text: "USA, Europa, Japan og andre enkeltregioner.", words: "usa europa japan" },
  em: { name: "Fremvoksende markeder", text: "Kina, India, Taiwan, Brasil med flere.", words: "fremvoksende emerging em kina india" },
  small: { name: "Små selskaper", text: "Mindre selskaper som de store indeksene hopper over.", words: "små selskaper small cap småselskap" },
  sector: { name: "Bransje og tema", text: "Teknologi, helse, biotek, forsvar og andre smale fond.", words: "bransje tema sektor" },
  mixed: { name: "Kombinasjonsfond", text: "Aksjer og renter i samme fond.", words: "kombinasjon balansert blandet" },
  bond: { name: "Renter og høyrente", text: "Obligasjoner, kreditt og høyrente. Svinger mer enn likviditet.", words: "renter obligasjon kreditt høyrente high yield" },
  safe: { name: "Likviditet", text: "Pengemarked og korte renter i kroner. Bufferen som demper fallene.", words: "likviditet pengemarked buffer rente" },
  other: { name: "Annet", text: "Råvarer, alternative fond og annet.", words: "" },
};
/** Role name inside a sentence: lower case, except the country names. */
const roleLc = (r) => ROLE[r].name.replace(/^\S+/, (w) => (/^Norge/.test(w) ? w : w.toLowerCase()));
const ROLE_ORDER = ["core", "nordic", "region", "em", "small", "sector", "mixed", "bond", "safe", "other"];
const ADD_ROLES = ["core", "nordic", "em", "small", "sector", "bond", "safe"];       // roles offered as «+ Legg til»

function emShare(id) {
  const r = holdingsOf(id)?.reg;
  if (!r) return null;
  const tot = Object.values(r).reduce((a, b) => a + b, 0);
  return tot > 0 ? EM_REGIONS.reduce((a, k) => a + (r[k] || 0), 0) / tot : null;
}
function isNordic(p) {
  if (/\b(norge|norsk|norden|nordic|nordisk|norway|obx|oslo)\b/i.test(p.name)) return true;
  const top = holdingsOf(p.id)?.top;
  if (!top?.length) return false;
  let n = 0, all = 0;
  for (const [hid, w] of top) { const cc = PF.H.names[hid]?.[1]; if (!cc) continue; all += w; if (NORDIC_CC.has(cc)) n += w; }
  return all > 20 && n / all >= 0.7;
}
/** Share of shares in a fund (0..1): from its holdings, or from the asset class. */
function eqShareOf(p) {
  const a = holdingsOf(p.id)?.ast;
  if (a && Object.keys(a).length) { const t = Object.values(a).reduce((x, y) => x + y, 0); if (t > 0) return Math.max(0, Math.min(1, (a.Aksjer || 0) / t)); }
  return p.asset_class === "Aksjer" ? 1 : p.asset_class === "Blandet" ? 0.5 : 0;
}
function roleOf(p) {
  if (!p) return "other";
  if (p._role) return p._role;
  let r;
  if (isRate(p)) r = p.currency === "NOK" && (p.asset_class === "Pengemarked" || (ok(p.vol) && p.vol < CREDIT.vol)) ? "safe" : "bond";
  else if (p.asset_class === "Blandet") r = "mixed";
  else if (p.asset_class !== "Aksjer") r = "other";
  else if (p.theme || (p.sector && p.sector !== "Bred")) r = "sector";
  else if (isNordic(p)) r = "nordic";
  else if (["Fremvoksende", "Kina", "India", "Latin-Amerika", "Midtøsten og Afrika"].includes(p.region)) r = "em";
  else if (p.style === "Små/mellomstore" || /small|mid\/small/i.test(p.category || "")) r = "small";
  else if (p.region === "Global") r = "core";
  else r = "region";
  p._role = r;
  return r;
}
/** A global fund that also holds emerging markets («hele verden i ett fond»). */
const isWorld = (p) => roleOf(p) === "core" && (emShare(p.id) ?? 0) >= EM_WORLD;

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
function savePF() {
  assignColors();
  store.set(PLS, { items: PF.items, plan: PF.plan, risk: PF.risk, profile: PF.profile ?? null, recipe: PF.recipe, nordic: PF.nordic });
}
PF.ids = () => new Set(PF.items.map((x) => x.id));
PF.product = product;
PF.twinsOf = twinsOf;
PF.max = MAX_ITEMS;
/** Add or remove a fund. Returns "added", "removed" or "full" (the portfolio already has MAX_ITEMS funds). */
PF.toggle = (id) => {
  const i = PF.items.findIndex((x) => x.id === id);
  if (i >= 0) { removeItem(i); return "removed"; }
  return addItem(id) ? "added" : "full";
};
PF.refresh = () => {
  PF.U = {}; PF.S = {}; PF.X = {}; PF.nameIdx = null; PF.blocks = null; PF.cand = null;
  if (PF.ready) { renderPfTable(); analyse(); renderReco(); }
};

// ---------------------------------------------------------------- shares that always sum to 100 %
const sumW = () => PF.items.reduce((a, x) => a + (+x.w || 0), 0);
function scaleTo100() {
  const s = sumW();
  if (s <= 0) { PF.items.forEach((x) => { x.w = 100 / PF.items.length; }); return roundWeights(); }
  PF.items.forEach((x) => { x.w = (+x.w || 0) * 100 / s; });
  roundWeights();
}
/** Whole percent that sum to 100 (largest remainders). The share of item `keep` is left as it is. */
function roundWeights(keep = -1) {
  I.wholePercent(PF.items.map((x) => x.w), keep).forEach((w, i) => { PF.items[i].w = w; });
}
const ABSORB = ["safe", "bond", "mixed", "core"];
/** The fund that takes up the difference when another share changes: the first unlocked fund in the roles
 *  Likviditet, Renter, Kombinasjon or Global kjerne, else the largest unlocked fund. -1 if every other fund is locked. */
function absorberIndex(skip = -1) {
  const free = PF.items.map((_, i) => i).filter((i) => i !== skip && !PF.items[i].lock);
  if (!free.length) return -1;
  for (const r of ABSORB) { const i = free.find((k) => roleOf(product(PF.items[k].id)) === r); if (i !== undefined) return i; }
  return free.sort((a, b) => PF.items[b].w - PF.items[a].w)[0];
}
/** Set the share of item i. The fund that takes the rest (absorberIndex) moves first, then the other unlocked funds
 *  in proportion; locked funds never move. Returns the share actually set. */
function setWeight(i, v) {
  const it = PF.items[i];
  if (!it) return 0;
  if (Math.abs(sumW() - 100) > 0.5) scaleTo100();
  I.setShare(PF.items.map((x) => x.w), PF.items.map((x) => !!x.lock), i, v, PF.items.length === 1 ? 0 : absorberIndex(i))
    .forEach((w, k) => { PF.items[k].w = w; });
  return it.w;
}
/** Equal shares for the unlocked funds; locked funds keep theirs. */
function equalShares() {
  const free = PF.items.filter((x) => !x.lock);
  if (!free.length) return;
  const room = 100 - PF.items.filter((x) => x.lock).reduce((a, x) => a + x.w, 0);
  free.forEach((x) => { x.w = room / free.length; });
  roundWeights();
}
function addItem(id, w = 0) {
  if (!product(id) || PF.items.some((x) => x.id === id) || PF.items.length >= MAX_ITEMS) return false;
  if (PF.items.length && Math.abs(sumW() - 100) > 0.5) scaleTo100();
  PF.items.push({ id, w: PF.items.length ? 0 : 100 });
  if (w > 0 && PF.items.length > 1) setWeight(PF.items.length - 1, w);
  PF.focusId = id;
  membersChanged();
  return true;
}
/** Add from the builder; says so when the portfolio is full. */
function tryAdd(id) {
  if (PF.items.length >= MAX_ITEMS && !PF.items.some((x) => x.id === id)) {
    toast(`<span>Porteføljen har allerede ${MAX_ITEMS} fond og ETF-er. Fjern ett før du legger til et nytt.</span>`);
    return false;
  }
  return addItem(id);
}
function removeItem(i) {
  const [gone] = PF.items.splice(i, 1);
  if (PF.items.length) {
    const a = absorberIndex();
    if (a >= 0 && gone) PF.items[a].w += gone.w; else scaleTo100();
    roundWeights();
  }
  membersChanged();
}
function swapItem(id, withId) {
  const it = PF.items.find((x) => x.id === id);
  if (!it || !product(withId)) return;
  const other = PF.items.find((x) => x.id === withId);
  if (other) {
    other.w += it.w;
    if (ok(it.have)) other.have = (other.have || 0) + it.have;
    PF.items.splice(PF.items.indexOf(it), 1);
  } else { it.id = withId; }
  membersChanged();
}
function membersChanged() {
  PF.risk = "same";
  savePF();
  renderPfTable();
  analyse();
  renderReco();
  if (typeof onPortfolioMembers === "function") onPortfolioMembers();
  if (typeof onPortfolioMembersFond === "function") onPortfolioMembersFond();
}
const analyseLater = debounce(() => { savePF(); analyse(); renderReco(); }, 150);

// ---------------------------------------------------------------- setup
function setupPortfolio() {
  const wait = () => (D.ready ? ensureFond().then(() => fetch("data/innhold.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)) : new Promise((res) => setTimeout(res, 80)).then(wait));
  wait().then((H) => {
    if (!FS.data) return;                       // fund data failed: fond.js has shown the error
    if (H && H.items) PF.H = H;
    else notice($("pf-status"), "warning", "<strong>⚠ Innholdet i fondene mangler:</strong> «Hva eier jeg egentlig?» og tvillinger kan ikke vises før <code>data/innhold.json</code> er laget.");
    const saved = store.get(PLS, null);
    if (saved) {
      PF.items = (saved.items || []).filter((x) => product(x.id));
      Object.assign(PF.plan, saved.plan || {});
      PF.profile = saved.profile ?? null;
      PF.recipe = saved.recipe === "world" ? "world" : "blocks";
      PF.nordic = !!saved.nordic;
    }
    readPfHash();
    if (PF.items.length && Math.abs(sumW() - 100) > 0.5) scaleTo100();    // older portfolios and shared links
    PF.risk = "same";
    assignColors();
    bindPlan(); bindSearch(); bindButtons(); bindReco();
    $("reco").open = !PF.items.length;
    renderPfMethod();
    PF.ready = true;
    renderPfTable();
    analyse();
    renderReco();
    redraw.push(() => { if (PF.res) renderCharts(); });
    onPortfolioMembers(); onPortfolioMembersFond();
  });
}

function readPfHash() {
  const m = location.hash.match(/^#pf=(.+)$/);
  if (!m) return;
  const items = m[1].split(",").map((s) => { const [id, w] = s.split(":"); return { id, w: Math.max(0, +w || 0) }; }).filter((x) => product(x.id));
  if (items.length) { PF.items = items; PF.risk = "same"; savePF(); }
  history.replaceState(null, "", location.pathname + location.search + "#portefolje");
}

/** «Har i dag» follows the amounts in «Eier i dag» once any of them is filled in. */
function haveSum() {
  const xs = PF.items.filter((x) => ok(x.have) && x.have > 0);
  return xs.length ? xs.reduce((a, x) => a + x.have, 0) : null;
}
function syncStart() {
  const hs = haveSum(), el = $("pl-start"), note = $("pl-start-note");
  if (ok(hs)) { PF.plan.start = hs; el.value = hs; }
  el.readOnly = ok(hs);
  if (note) note.hidden = !ok(hs);
}

function bindPlan() {
  const map = { "pl-start": "start", "pl-monthly": "monthly", "pl-years": "years", "pl-ret": "ret" };
  for (const [id, key] of Object.entries(map)) {
    const el = $(id);
    el.value = PF.plan[key] ?? "";
    el.addEventListener("input", () => {
      if (el.readOnly) return;
      const v = el.value === "" ? null : +el.value;
      PF.plan[key] = key === "ret" ? (ok(v) && v >= 0 ? v : null) : key === "years" ? Math.max(1, Math.min(50, Math.round(v || 1))) : Math.max(0, v || 0);
      updateAmounts(); renderBuyPlan(); analyseLater();
      if (key === "years" && PF.profile == null) renderReco();
    });
  }
  syncStart();
}

// ---------------------------------------------------------------- search
function searchHay(p) {
  if (p._hay) return p._hay;
  const r = ROLE[roleOf(p)];
  p._hay = [p.name, p.ticker, p.id, p.kindLabel, r.name, r.words, p.index ? "indeks index" : "", p.sector && p.sector !== "Bred" ? p.sector : "",
    p.theme || "", p.region || "", isWorld(p) ? ROLE.em.words : ""].join(" ").toLowerCase();
  return p._hay;
}
/** Two products with nearly the same content (same index, or twins by holdings, or the same kind of interest fund). */
function sameContent(a, b) {
  if (a.cluster !== null && a.cluster === b.cluster) return true;
  if (a.asset_class !== b.asset_class || a.hedged !== b.hedged) return false;
  if (isRate(a)) return rateTwin(a, b);
  return isTwin(I.similarity(holdingsOf(a.id), holdingsOf(b.id)));
}
/** Search hits as groups: one fund or ETF per content, with its twins. `role` limits the hits to one role. */
function searchProducts(q, role = null) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length && !role) return [];
  const mine = PF.ids(), pin = role ? recoPick(role) : null;
  const hits = allProducts().filter((p) => !mine.has(p.id) && !p.leveraged && p.tradable && (!role || roleOf(p) === role) && words.every((w) => searchHay(p).includes(w)))
    .sort((a, b) => (b.id === pin) - (a.id === pin) || (b.owners || 0) - (a.owners || 0)).slice(0, 80);
  const groups = [];
  for (const p of hits) {
    const g = groups.find((x) => sameContent(x.p, p));
    if (g) g.twins.push(p); else if (groups.length < 12) groups.push({ p, twins: [], pin: p.id === pin });
  }
  return groups;
}
function bindSearch() {
  const q = $("pf-q"), box = $("pf-results"), chip = $("pf-q-role");
  const close = () => { box.hidden = true; q.setAttribute("aria-expanded", "false"); };
  const setRole = (r) => {
    PF.searchRole = r;
    chip.hidden = !r;
    chip.innerHTML = r ? `Bare ${esc(roleLc(r))} <span aria-hidden="true">×</span><span class="visually-hidden">: vis alle</span>` : "";
    q.placeholder = r ? `Søk i ${roleLc(r)}, eller velg fra listen` : "Søk på navn, for eksempel «global indeks», «teknologi» eller «høyrente»";
  };
  const show = () => {
    const r = PF.searchRole;
    if (!q.value.trim() && !r) return close();
    const res = searchProducts(q.value, r);
    box.innerHTML = res.length ? res.map(({ p, twins, pin }) => {
      const cheap = twins.filter((t) => ok(t.cost) && ok(p.cost) && t.cost < p.cost - TWIN.cheaper).sort((a, b) => a.cost - b.cost)[0];
      const tw = twins.length ? `<span class="tw small-text">${twins.length === 1 ? "1 annen" : `${twins.length} andre`} med nesten samme innhold${cheap ? `, billigst ${esc(cheap.name)} (${nf(2).format(cheap.cost)} %)` : ""}</span>` : "";
      return `<button type="button" role="option" data-id="${esc(p.id)}">
        <span class="nm">${esc(p.name)}</span><span class="tag">${esc(p.kindLabel)}</span><span class="tag tag-role">${esc(ROLE[roleOf(p)].name)}</span>
        ${pin ? '<span class="vv-badge vv-badge--info">Anbefalt</span>' : ""}${isWorld(p) ? '<span class="tag">inkl. fremvoksende</span>' : ""}${p.acc === false ? '<span class="tag">utdelende</span>' : ""}${p.divMissing ? '<span class="tag tag-warn">utbytte mangler i kursene</span>' : ""}
        <span class="muted">${ok(p.cost) ? nf(2).format(p.cost) + " % per år" : ""}${ok(p.ret[5]) ? " · 5 år: " + pct(p.ret[5]) : ""}</span>${tw}</button>`;
    }).join("") : '<p class="muted">Ingen treff. Prøv færre ord, eller bruk Finn fond / Finn ETF-er.</p>';
    box.hidden = false; q.setAttribute("aria-expanded", "true");
  };
  PF.openSearch = (r) => { setRole(r); q.value = ""; q.focus(); show(); };
  q.addEventListener("input", debounce(show, 120));
  q.addEventListener("focus", show);
  q.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { close(); if (PF.searchRole) setRole(null); }
    if (ev.key === "Enter") { const b = box.querySelector("button[data-id]"); if (b && !box.hidden) b.click(); }
    if (ev.key === "ArrowDown") { const b = box.querySelector("button[data-id]"); if (b && !box.hidden) { ev.preventDefault(); b.focus(); } }
  });
  box.addEventListener("keydown", (ev) => {
    const all = [...box.querySelectorAll("button[data-id]")], i = all.indexOf(document.activeElement);
    if (ev.key === "ArrowDown" && i >= 0) { ev.preventDefault(); all[Math.min(all.length - 1, i + 1)].focus(); }
    if (ev.key === "ArrowUp" && i >= 0) { ev.preventDefault(); (i ? all[i - 1] : q).focus(); }
    if (ev.key === "Escape") { close(); q.focus(); }
  });
  box.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-id]"); if (!b) return;
    tryAdd(b.dataset.id); q.value = ""; setRole(null); close();
  });
  chip.addEventListener("click", () => { setRole(null); q.focus(); show(); });
  document.addEventListener("click", (ev) => { if (!ev.target.closest(".pf-search") && !ev.target.closest("[data-addrole]")) close(); });
  setRole(null);
}

// ---------------------------------------------------------------- recommended portfolio
const PROFILES = [[20, "Forsiktig"], [40, "Moderat"], [60, "Balansert"], [80, "Offensiv"], [100, "Bare aksjer"]];
const RECO = { core: 0.8, em: 0.1, small: 0.1, nordic: 0.1, minPiece: 3 };   // split of the share part; pieces under 3 % go to the core
const RECO_TEXT = {
  core: ["Kjernen", "Rundt 1 500 store selskaper i hele den rike verden, i ett billig fond."],
  world: ["Kjernen", "Hele verden i ett fond: de rike landene og fremvoksende markeder."],
  nordic: ["Norge og Norden", "Selskapene på børsene i Norge, Sverige, Danmark og Finland."],
  norway: ["Norge og Norden", "Selskapene på Oslo Børs, i kroner."],
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
  const em = (f) => emShare(f.isin) ?? 0;
  PF.blocks = {
    core: pick((f) => idx("Global Equity Large Cap")(f) && em(f) < EM_WORLD),
    world: pick((f) => idx("Global Equity Large Cap")(f) && em(f) >= EM_WORLD),
    nordic: pick((f) => f.index && f.ask && !f.esg && f.asset_class === "Aksjer" && roleOf(product(f.isin)) === "nordic"),
    em: pick(idx("Global Emerging Markets Equity")), small: pick(idx("Global Equity Mid/Small Cap")),
    safe: pick((f) => isRate(f) && ok(f.vol5) && f.vol5 < 0.012),
  };
  return PF.blocks;
}
/** The recommended fund for a builder role, if the recipe has one. */
function recoPick(role) {
  const B = recoBlocks();
  return role === "core" ? (PF.recipe === "world" && B.world) || B.core : B[role] || null;
}
function defaultProfile() { const y = PF.plan.years; return y <= 2 ? 20 : y <= 5 ? 40 : y <= 9 ? 60 : 80; }
/** [{id, w (percent), role}] for a share of equities (percent), following the chosen recipe. */
function recoFor(eq) {
  const B = recoBlocks(), world = PF.recipe === "world" && B.world ? B.world : null, nordic = PF.nordic && B.nordic;
  const core = world || B.core;
  if (!core || !B.safe) return null;
  const raw = { nordic: nordic ? eq * RECO.nordic : 0, em: !world && B.em ? eq * RECO.em : 0, small: !world && B.small ? eq * RECO.small : 0, safe: 100 - eq };
  for (const k of ["nordic", "em", "small"]) if (raw[k] < RECO.minPiece) raw[k] = 0;
  raw.core = eq - raw.nordic - raw.em - raw.small;
  const ids = { ...B, core };
  const out = ["core", "nordic", "em", "small", "safe"].filter((k) => raw[k] > 0).map((k) => ({ id: ids[k], w: Math.round(raw[k]), role: k, text: k === "core" && world ? "world" : k === "nordic" && !/nord/i.test(product(ids[k]).name) ? "norway" : k }));
  out[0].w += 100 - out.reduce((a, x) => a + x.w, 0);
  return out;
}
/** Colour slot per recipe role: four colours; with Norden the small companies share the neutral colour. */
function recoColor(role) {
  const m = PF.nordic ? { core: 1, safe: 2, em: 3, nordic: 4 } : { core: 1, safe: 2, em: 3, small: 4 };
  return m[role] || null;
}
const recoTok = (role) => (recoColor(role) ? `--chart-${recoColor(role)}` : "--chart-context");
const PROFILE_TEXT = {
  20: "Lite svingninger. For penger du trenger om få år.",
  40: "Noe svingninger. For sparing i tre til fem år.",
  60: "Like mye vekt på trygghet og vekst.",
  80: "Mest vekst, med en liten buffer. For lang sparing.",
  100: "Størst svingninger og høyest forventet avkastning.",
};
/** Share of shares in the portfolio (0..1). */
function equityShare() {
  const s = sumW();
  return s > 0 ? PF.items.reduce((a, x) => a + (x.w / s) * eqShareOf(product(x.id)), 0) : 0;
}
/** The builder role a recipe role fills. */
const recoRole = (k) => (k === "core" ? "core" : k);

function renderReco() {
  if (!PF.ready) return;
  const prof = PF.profile ?? defaultProfile(), rec = recoFor(prof), box = $("reco");
  if (!rec) { box.hidden = true; return; }
  const y = PF.plan.years, d = defaultProfile(), dn = PROFILES.find((x) => x[0] === d)[1], has = PF.items.length > 0;
  const eqNow = equityShare();
  const cards = $("reco-profile");
  if (!cards.children.length) {
    cards.innerHTML = PROFILES.map(([e, name]) => `<label class="radio-card"><input type="radio" name="reco-profile" value="${e}">
      <span class="rc-name">${name}</span><span class="rc-eq">${e} % aksjer</span><span class="rc-text">${PROFILE_TEXT[e]}</span>
      <span class="vv-badge vv-badge--info rc-default" hidden></span></label>`).join("");
  }
  cards.querySelectorAll(".radio-card").forEach((l) => {
    const inp = l.querySelector("input"), e = +inp.value, b = l.querySelector(".rc-default");
    inp.checked = e === prof;
    l.classList.toggle("is-checked", e === prof);
    b.hidden = e !== d; b.textContent = `Passer for ${y} år`;
  });
  $("reco-hint").textContent = has ? `Porteføljen din: ${pc0(eqNow)} aksjer` : "eller velg fondene selv i steg 3";
  const why = y <= 2 ? "pengene skal brukes snart og bør ikke svinge mye" : y <= 5 ? "noen få år er for kort tid til å hente inn et stort aksjefall"
    : y <= 9 ? "du har tid til å hente inn et fall, men ikke ubegrenset" : "du har god tid til å hente inn fall, og aksjer har gitt mest over tid";
  $("reco-why").innerHTML = `Med ${y} års sparing foreslår vi <strong>${dn}</strong>, fordi ${why}. Det viktigste er en fordeling du klarer å holde fast ved når det faller.` +
    (has ? ` Porteføljen din har <strong>${pc0(eqNow)} aksjer</strong>.` : "");
  const B = recoBlocks();
  const opt = $("reco-opts");
  if (!opt.children.length) {
    opt.innerHTML = `<fieldset class="reco-recipe"><legend>Oppskrift</legend>
        <label class="check"><input type="radio" name="reco-recipe" value="blocks"> Byggeklosser: globalt fond, fremvoksende markeder og små selskaper hver for seg</label>
        <label class="check"><input type="radio" name="reco-recipe" value="world"> Hele verden i ett fond: færre fond å følge med på</label></fieldset>
      <label class="check"><input type="checkbox" id="reco-nordic"> Ta med Norge og Norden (${pc0(RECO.nordic)} av aksjene)</label>`;
  }
  opt.querySelectorAll("input[name=reco-recipe]").forEach((r) => { r.checked = r.value === PF.recipe; r.disabled = r.value === "world" && !B.world; });
  $("reco-nordic").checked = PF.nordic; $("reco-nordic").disabled = !B.nordic;
  const mine = (k) => PF.items.find((x) => roleOf(product(x.id)) === recoRole(k) && (k !== "core" || PF.recipe !== "world" || isWorld(product(x.id))));
  mixbar("reco-bar", rec.map((x) => ({ label: RECO_TEXT[x.text][0], w: x.w / 100, tok: recoTok(x.role) })));
  $("reco-list").innerHTML = rec.map((x) => {
    const p = product(x.id), own = has ? mine(x.role) : null;
    const ownTxt = own ? `<span class="vv-badge vv-badge--info">${ICON.check}Du har ${esc(product(own.id).name)}</span>` : has ? '<span class="vv-badge">Mangler i porteføljen din</span>' : "";
    return `<div class="reco-row"><span class="swatch" style="background:${css(recoTok(x.role))}"></span>
      <div class="reco-w">${x.w} %</div><div><strong>${esc(RECO_TEXT[x.text][0])}:</strong> ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}
      <span class="vv-badge">${nf(2).format(p.cost)} % per år</span> ${ownTxt}<br><span class="small-text">${esc(RECO_TEXT[x.text][1])}</span></div></div>`;
  }).join("");
  const use = rec.map((x) => ({ item: x, p: product(x.id), w: x.w / 100, ser: seriesOf(x.id) }));
  const ev = evaluate(use);
  $("reco-stats").innerHTML = [
    ["Forventet avkastning", ev.model ? pct(ev.model.now.ret) + " per år" : "–"],
    ["Verste år", ev.story ? `${pct(ev.story.worst.ret, 0)}` : "–"],
    ["Kostnad", `${nf(2).format(ev.cost * 100)} % per år`],
    ["Antall fond", String(rec.length)],
  ].map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join("");
  const missing = rec.filter((x) => !mine(x.role));
  const eqOff = Math.abs(eqNow * 100 - prof) >= 1;
  $("reco-actions").innerHTML = !has
    ? '<button class="vv-btn vv-btn--primary" type="button" data-reco="use">Bruk denne porteføljen</button>'
    : [`<button class="vv-btn vv-btn--primary" type="button" data-reco="equity"${eqOff ? "" : " disabled"}>Sett aksjeandelen til ${prof} %</button>`,
      missing.length ? `<button class="vv-btn vv-btn--secondary" type="button" data-reco="missing">Legg til det som mangler (${missing.length})</button>` : "",
      '<button class="vv-btn vv-btn--ghost" type="button" data-reco="replace">Erstatt med oppskriften</button>'].join("");
  $("reco-note").textContent = has ? (eqOff ? `«Sett aksjeandelen» endrer bare andelene. Aksjefondene og rentefondene beholder innbyrdes forhold, og låste fond står fast.` : `Porteføljen din har allerede ${prof} % aksjer.`) : "";
  PF.reco = rec;
}

/** Move the portfolio to a share of equities (percent) by scaling the share funds and the other funds; adds the recipe's
 *  buffer or core fund if one side is missing. Locked funds stay when that is possible. */
function setEquity(T) {
  const t = T / 100, B = recoBlocks(), heavy = (x) => eqShareOf(product(x.id)) >= 0.5;
  if (t < 0.999 && !PF.items.some((x) => !heavy(x)) && B.safe && PF.items.length < MAX_ITEMS) PF.items.push({ id: B.safe, w: 0 });
  if (t > 0.001 && !PF.items.some(heavy) && recoPick("core") && PF.items.length < MAX_ITEMS) PF.items.push({ id: recoPick("core"), w: 0 });
  const solve = (useLocks) => {
    const fixed = PF.items.filter((x) => useLocks && x.lock), free = PF.items.filter((x) => !(useLocks && x.lock));
    const L = fixed.reduce((a, x) => a + x.w / 100, 0), Le = fixed.reduce((a, x) => a + x.w / 100 * eqShareOf(product(x.id)), 0);
    const G = free.filter(heavy), R = free.filter((x) => !heavy(x));
    const base = (xs) => { const s = xs.reduce((a, x) => a + x.w, 0); return xs.map((x) => (s > 0 ? x.w : 1)); };
    const bg = base(G), br = base(R);
    const g = bg.reduce((a, b) => a + b, 0) / 100, r = br.reduce((a, b) => a + b, 0) / 100;
    const ge = G.reduce((a, x, k) => a + bg[k] / 100 * eqShareOf(product(x.id)), 0), re = R.reduce((a, x, k) => a + br[k] / 100 * eqShareOf(product(x.id)), 0);
    let a, b;
    if (!R.length) { a = g > 0 ? (1 - L) / g : 0; b = 0; } else if (!G.length) { a = 0; b = r > 0 ? (1 - L) / r : 0; } else {
      const det = g * re - r * ge;
      if (Math.abs(det) < 1e-9) return false;
      a = ((1 - L) * re - r * (t - Le)) / det; b = (g * (t - Le) - ge * (1 - L)) / det;
    }
    if (!(a >= 0 && b >= 0)) return false;
    G.forEach((x, k) => { x.w = bg[k] * a; }); R.forEach((x, k) => { x.w = br[k] * b; });
    return true;
  };
  if (!solve(true) && !solve(false)) return;
  roundWeights();
  membersChanged();
}
/** Add the recipe funds whose role the portfolio lacks, at the recipe's shares; the funds already there share the rest. */
function addMissing() {
  const rec = PF.reco; if (!rec) return;
  const has = (k) => PF.items.some((x) => roleOf(product(x.id)) === recoRole(k) && (k !== "core" || PF.recipe !== "world" || isWorld(product(x.id))));
  const add = rec.filter((x) => !has(x.role) && !PF.items.some((i) => i.id === x.id)).slice(0, MAX_ITEMS - PF.items.length);
  if (!add.length) return;
  const room = 100 - add.reduce((a, x) => a + x.w, 0), s = sumW() || 1;
  PF.items.forEach((x) => { x.w = x.w * room / s; });
  add.forEach((x) => PF.items.push({ id: x.id, w: x.w }));
  roundWeights();
  setEquity(PF.profile ?? defaultProfile());           // keep the chosen share of equities
}
function useReco(replace) {
  if (!PF.reco) return;
  if (replace && PF.items.length && !confirm("Erstatte porteføljen din med den anbefalte? Beløpene under «Eier i dag» forsvinner.")) return;
  PF.items = PF.reco.map((x) => ({ id: x.id, w: x.w, c: recoColor(x.role) ? recoColor(x.role) - 1 : SLOTS }));
  $("reco").open = false;
  membersChanged();
  syncStart();
  $("pf-bygg").scrollIntoView();
}
function bindReco() {
  $("reco-profile").addEventListener("change", (ev) => {
    const r = ev.target.closest("input[name=reco-profile]"); if (!r) return;
    PF.profile = +r.value; savePF(); renderReco();
  });
  $("reco-opts").addEventListener("change", (ev) => {
    const r = ev.target.closest("input[name=reco-recipe]");
    if (r) PF.recipe = r.value;
    if (ev.target.id === "reco-nordic") PF.nordic = ev.target.checked;
    savePF(); renderReco();
  });
  $("reco-actions").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-reco]"); if (!b) return;
    const k = b.dataset.reco;
    if (k === "use") useReco(false);
    if (k === "replace") useReco(true);
    if (k === "equity") setEquity(PF.profile ?? defaultProfile());
    if (k === "missing") addMissing();
  });
}

// ---------------------------------------------------------------- buttons
function bindButtons() {
  $("pf-equal").addEventListener("click", () => { equalShares(); membersChanged(); });
  $("pf-clear").addEventListener("click", () => { if (PF.items.length && confirm("Fjerne alt fra porteføljen?")) { PF.items = []; membersChanged(); syncStart(); } });
  $("pf-link").addEventListener("click", () => {
    const url = `${location.origin}${location.pathname}#pf=${PF.items.map((x) => `${x.id}:${Math.round(x.w)}`).join(",")}`;
    const msg = $("pf-copied"), done = () => { msg.textContent = "Lenken er kopiert."; setTimeout(() => { msg.textContent = ""; }, 3000); };
    (navigator.clipboard?.writeText(url) || Promise.reject()).then(done).catch(() => prompt("Kopier lenken:", url));
  });
  const list = $("pf-table");
  list.addEventListener("input", (ev) => {
    const w = ev.target.closest("input[data-w]");
    if (w) {
      if (w.value === "") return;
      const i = +w.dataset.w;
      setWeight(i, +w.value);
      PF.risk = "same";
      syncRows(w); analyseLater();
      return;
    }
    const h = ev.target.closest("input[data-have]");
    if (h) {
      const it = PF.items[+h.dataset.have]; if (!it) return;
      it.have = h.value === "" ? null : Math.max(0, +h.value || 0);
      syncStart(); updateAmounts(); renderBuyPlan(); analyseLater();
    }
  });
  list.addEventListener("change", (ev) => { const w = ev.target.closest("input[data-w]"); if (w) syncRows(); });
  list.addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.rm !== undefined) return removeItem(+b.dataset.rm);
    if (b.dataset.lock !== undefined) { const it = PF.items[+b.dataset.lock]; it.lock = !it.lock; savePF(); renderPfTable(); return; }
    if (b.dataset.alt !== undefined) {
      const row = $(`pf-alt-${b.dataset.alt}`), open = b.getAttribute("aria-expanded") !== "true";
      if (open && !row.dataset.done) { row.innerHTML = altsHtml(PF.items[+b.dataset.alt].id); row.dataset.done = "1"; }
      row.hidden = !open; b.setAttribute("aria-expanded", open ? "true" : "false");
      return;
    }
    if (b.dataset.swapfrom) return swapItem(b.dataset.swapfrom, b.dataset.swapto);
  });
  $("pf-roles-add").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-addrole]"); if (!b) return;
    if (PF.items.length >= MAX_ITEMS) return tryAdd("");
    PF.openSearch(b.dataset.addrole);
  });
  $("glance-body").addEventListener("click", (ev) => { if (ev.target.closest("button[data-world]")) mergeWorld(); });
  $("twins").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-swap]"); if (b) return swapItem(b.dataset.swap, b.dataset.with);
    const m = ev.target.closest("button[data-more]"); if (!m) return;
    const row = $(m.getAttribute("aria-controls")), open = m.getAttribute("aria-expanded") !== "true";
    row.hidden = !open; m.setAttribute("aria-expanded", open ? "true" : "false");
    m.textContent = open ? "Skjul alternativer" : "Vis flere alternativer";
  });
  $("sg-apply").addEventListener("click", () => {
    const sg = PF.res?.sg; if (!sg) return;
    PF.res.use.forEach((u, k) => { u.item.w = sg.w[k] * 100; });
    PF.items = PF.items.filter((x) => x.w >= 0.5 || !PF.res.use.some((u) => u.item === x) || ok(x.have));
    scaleTo100(); membersChanged();
    $("pf-bygg").scrollIntoView();
  });
}

// ---------------------------------------------------------------- the builder: funds grouped by role
const infoBadge = (label, tip) => `<span class="vv-badge vv-badge--info tip" tabindex="0" data-tip="${esc(tip)}">${ICON.info}${esc(label)}<span class="visually-hidden">: ${esc(tip)}</span></span>`;
function estTip(p, s) {
  return s?.kind === "proxy"
    ? `Fond har ikke kurshistorikk hos oss. Svingningene måned for måned er lånt fra ${D.by[s.proxy]?.name || "en lignende ETF"} og justert til fondets egen avkastning og risiko.`
    : "Fond har ikke kurshistorikk hos oss. Svingningene er anslått fra fondets egen avkastning og risiko.";
}
const pName = (p) => (p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name));

function renderPfTable() {
  const el = $("pf-table"), n = PF.items.length;
  const cnt = $("pf-count"); cnt.hidden = !n; cnt.innerHTML = `${n}<span class="visually-hidden"> fond i porteføljen</span>`;
  $("pf-body").hidden = !n; $("pf-empty").hidden = !!n; $("glance-body").hidden = !n; $("glance-empty").hidden = !!n;
  assignColors();
  ["pf-equal", "pf-link", "pf-clear"].forEach((id) => { $(id).hidden = !n; });
  renderRoleChips();
  if (!n) {
    el.innerHTML = '<p class="pf-empty-row">Porteføljen er tom. Velg en anbefalt portefølje i steg 2, legg til en rolle under, eller søk etter fondene du allerede har.</p>';
    $("pf-foot").innerHTML = "";
    renderBuyPlan();
    return;
  }
  const groups = ROLE_ORDER.map((r) => ({ r, rows: PF.items.map((it, i) => ({ it, i })).filter(({ it }) => roleOf(product(it.id)) === r) })).filter((g) => g.rows.length);
  el.innerHTML = groups.map(({ r, rows }) => `<section class="role-group" aria-labelledby="role-h-${r}">
      <div class="role-head"><h3 id="role-h-${r}">${esc(ROLE[r].name)}</h3><span class="role-sum" data-rolesum="${r}"></span></div>
      ${rows.map(({ it, i }) => rowHtml(it, i)).join("")}</section>`).join("");
  updateAmounts();
  renderBuyPlan();
  if (PF.focusId) {
    const i = PF.items.findIndex((x) => x.id === PF.focusId);
    PF.focusId = null;
    const inp = el.querySelector(`input[type=number][data-w="${i}"]`);
    if (inp && n > 1) { inp.focus(); inp.select?.(); }
  }
}
function rowHtml(it, i) {
  const p = product(it.id), s = seriesOf(it.id);
  const est = p.kind === "fond" ? infoBadge("historikk anslått", estTip(p, s)) : "";
  const div = divBadges(p);
  const world = isWorld(p) ? infoBadge("inkl. fremvoksende", `Fondet har ${pc0(emShare(p.id))} av aksjene i fremvoksende markeder, så det dekker også den rollen.`) : "";
  const meta = [ok(p.cost) ? `${nf(2).format(p.cost)} % per år` : "", ok(p.ret[5]) ? `5 år: ${pct(p.ret[5])} per år` : ""].filter(Boolean).join(" · ");
  return `<div class="pf-row${it.lock ? " is-locked" : ""}" data-row="${i}">
    <div class="pf-row-name">${swatch(it)}${pName(p)}</div>
    <div class="pf-badges"><span class="vv-badge">${esc(p.kindLabel)}</span>${world}${div}${est}<span class="vv-badge vv-badge--info rest-badge" data-rest="${i}" hidden>Tar resten</span></div>
    <p class="pf-row-meta small-text muted">${meta}<span data-target="${i}"></span></p>
    <div class="pf-row-ctrl">
      <div class="share"><label for="w-${i}">Andel</label>
        <input type="range" min="0" max="100" step="1" value="${Math.round(it.w)}" data-w="${i}" aria-label="Andel ${esc(p.name)}" tabindex="-1">
        <span class="unit"><input id="w-${i}" type="number" inputmode="numeric" min="0" max="100" step="1" value="${Math.round(it.w)}" data-w="${i}"><i>%</i></span></div>
      <div class="have"><label for="h-${i}">Eier i dag</label>
        <span class="unit"><input id="h-${i}" type="number" inputmode="numeric" min="0" step="1000" placeholder="0" value="${ok(it.have) ? it.have : ""}" data-have="${i}"><i>kr</i></span></div>
      <div class="row-btns">
        <button type="button" class="vv-btn vv-btn--ghost" data-lock="${i}" aria-pressed="${!!it.lock}" title="${it.lock ? "Låst: andelen står fast når du endrer de andre" : "Lås andelen, så den står fast når du endrer de andre"}">${it.lock ? "Låst" : "Lås"}<span class="visually-hidden"> andelen for ${esc(p.name)}</span></button>
        <button type="button" class="vv-btn vv-btn--ghost" data-alt="${i}" aria-expanded="false" aria-controls="pf-alt-${i}">Bytt<span class="visually-hidden"> ${esc(p.name)}</span></button>
        <button type="button" class="vv-btn vv-btn--ghost" data-rm="${i}" aria-label="Fjern ${esc(p.name)}">Fjern</button>
      </div>
    </div>
    <div class="pf-alt" id="pf-alt-${i}" hidden></div>
  </div>`;
}
/** Badges for distributing funds: the yield, and notes when the price data missed dividends (see dividends.py). */
function divBadges(p) {
  const out = [];
  if (p.acc === false) out.push(infoBadge(ok(p.yield12) && p.yield12 > 0 ? `Utdelende, ${nf(1).format(p.yield12 * 100)}\u00a0% i utbytte` : "Utdelende",
    "Utbyttet kommer som kontanter på kontoen. Tallene på siden regner med at du kjøper for utbyttet igjen. Se kjøpsplanen." +
    (ok(p.yield12) && p.yield12 > 0 ? " Prosenten er utbyttet de siste 12 månedene delt på kursen." : "")));
  if (p.divFix) out.push(infoBadge("Utbytte rettet", `Kursdataene manglet utbytte for denne ETF-en. Avkastningen er hentet fra ${D.by[p.divFix]?.name || "en akkumulerende ETF på samme indeks"} og justert for forskjellen i kostnad.`));
  if (p.divMissing) out.push(`<span class="vv-badge vv-badge--negative tip" tabindex="0" data-tip="Kursdataene har ikke utbytte for de siste 12 månedene. Avkastningen på siden kan derfor være for lav. Sjekk utbyttet hos Nordnet.">Utbytte mangler i kursene<span class="visually-hidden">: Kursdataene har ikke utbytte for de siste 12 månedene. Avkastningen på siden kan derfor være for lav.</span></span>`);
  return out.join("");
}
/** Funds to swap to: twins first (cheapest), then the most owned in the same role (same sector or region). */
function altsHtml(id) {
  const p = product(id), role = roleOf(p);
  const tw = twinsOf(id, { all: true }).slice(0, 4), seen = new Set([id, ...tw.map((t) => t.p.id), ...PF.ids()]);
  const key = (c) => (role === "sector" ? `${c.sector}|${c.theme || ""}` : role === "em" || role === "region" ? c.region : role === "bond" ? c.sector : "");
  const k0 = key(p);
  const others = allProducts().filter((c) => !seen.has(c.id) && roleOf(c) === role && key(c) === k0 && c.tradable && !c.leveraged && ok(c.cost) && (!p.ask || c.ask))
    .sort((a, b) => (b.owners || 0) - (a.owners || 0)).slice(0, 4);
  const line = (c, label) => `<li><div><span class="nm">${pName(c)}</span> <span class="vv-badge">${esc(c.kindLabel)}</span>${label ? ` <span class="vv-badge vv-badge--info">${esc(label)}</span>` : ""}
      <span class="small-text muted">${ok(c.cost) ? nf(2).format(c.cost) + " % per år" : ""}${ok(c.ret[5]) ? ` · 5 år: ${pct(c.ret[5])}` : ""}</span></div>
      <button type="button" class="vv-btn vv-btn--secondary" data-swapfrom="${esc(id)}" data-swapto="${esc(c.id)}">Bytt til denne<span class="visually-hidden">: ${esc(c.name)}</span></button></li>`;
  const tws = tw.filter((t) => !PF.ids().has(t.p.id));
  return (tws.length ? `<h4>Samme innhold</h4><ul class="alt-list">${tws.map((t) => line(t.p, t.label)).join("")}</ul>` : "") +
    (others.length ? `<h4>Andre i ${esc(roleLc(role))}</h4><ul class="alt-list">${others.map((c) => line(c, "")).join("")}</ul>` : "") +
    (!tws.length && !others.length ? '<p class="small-text muted">Vi finner ingen andre fond i samme rolle.</p>' : "") +
    '<p class="small-text muted">Andelen og beløpet følger med til fondet du bytter til.</p>';
}
function renderRoleChips() {
  const have = new Set(PF.items.map((x) => roleOf(product(x.id))));
  if (have.has("core") && PF.items.some((x) => isWorld(product(x.id)))) have.add("em");
  const full = PF.items.length >= MAX_ITEMS;
  $("pf-roles-add").innerHTML = `<span class="small-text muted">${full ? `Porteføljen er full (${MAX_ITEMS} fond).` : "Legg til en rolle:"}</span>` + (full ? "" :
    ADD_ROLES.filter((r) => r === "sector" || r === "bond" || !have.has(r)).map((r) =>
      `<button type="button" class="vv-btn vv-btn--secondary role-chip" data-addrole="${r}" title="${esc(ROLE[r].text)}">+ ${esc(ROLE[r].name)}</button>`).join(""));
}
/** Update inputs, sums and badges after a share changed, without rebuilding the rows (keeps focus). */
function syncRows(active = null) {
  document.querySelectorAll("#pf-table input[data-w]").forEach((inp) => {
    if (inp === active) return;
    const it = PF.items[+inp.dataset.w]; if (it) inp.value = Math.round(it.w);
  });
  updateAmounts(); renderBuyPlan();
}
function updateAmounts() {
  const sum = sumW(), n = PF.items.length;
  PF.items.forEach((it, i) => { const c = document.querySelector(`[data-target="${i}"]`); if (c) c.textContent = ` · Mål i dag: ${kr(PF.plan.start * (sum > 0 ? it.w / sum : 0))}`; });
  const a = absorberIndex();
  document.querySelectorAll("#pf-table [data-rest]").forEach((b) => { b.hidden = +b.dataset.rest !== a || n < 2; });
  document.querySelectorAll("#pf-table [data-rolesum]").forEach((s) => {
    const r = s.dataset.rolesum;
    s.textContent = pc0(PF.items.filter((x) => roleOf(product(x.id)) === r).reduce((x, it) => x + it.w, 0) / 100);
  });
  if (!n) return;
  const cost = sum > 0 ? PF.items.reduce((x, it) => x + (it.w / sum) * (product(it.id).cost ?? 0), 0) : null;
  const zero = PF.items.filter((x) => !(x.w > 0)).length;
  $("pf-foot").innerHTML = `<p class="pf-total"><strong>Sum ${nf(0).format(sum)} %</strong><span>${n} av høyst ${MAX_ITEMS} fond</span><span>${pc0(equityShare())} aksjer</span><span>${ok(cost) ? nf(2).format(cost) + " % per år" : ""}</span></p>` +
    (n > 1 ? `<p class="small-text muted">Når du endrer en andel, tar ${a >= 0 ? `<strong>${esc(product(PF.items[a].id).name)}</strong>` : "ingen"} resten, så summen alltid er 100 %. Lås et fond for å holde andelen fast.</p>` : "") +
    (zero ? `<p class="small-text">${zero === 1 ? "Ett fond har" : `${zero} fond har`} andel 0 % og er ikke med i tallene. Skriv inn andelen.</p>` : "") +
    (n > MAX_ITEMS ? `<p class="small-text">Porteføljen har ${n} fond. Byggeren tar høyst ${MAX_ITEMS}; fjern noen for å legge til nye.</p>` : "");
  renderCount();
}

/** Glance panel: number of funds and a way to fewer funds. */
function renderCount() {
  const n = PF.items.length, B = recoBlocks();
  const core = PF.items.find((x) => roleOf(product(x.id)) === "core" && !isWorld(product(x.id)));
  const em = PF.items.filter((x) => roleOf(product(x.id)) === "em" && x.w > 0);
  const world = B.world && !PF.ids().has(B.world) ? product(B.world) : null;
  $("pf-count-note").innerHTML = `<span><strong>${n}</strong> av høyst ${MAX_ITEMS} fond</span><span><strong>${pc0(equityShare())}</strong> aksjer</span>` +
    (core && em.length && world ? `<span class="glance-tip">Kan bli færre: ${esc(world.name)} (${nf(2).format(world.cost)} %) har global kjerne og fremvoksende markeder i ett fond.
      <button type="button" class="vv-btn vv-btn--ghost" data-world>Slå sammen til ett verdensfond</button></span>` : "");
}
/** Replace the core fund and the emerging markets funds with one world fund, keeping their total share. */
function mergeWorld() {
  const B = recoBlocks(); if (!B.world) return;
  const core = PF.items.find((x) => roleOf(product(x.id)) === "core" && !isWorld(product(x.id)));
  const em = PF.items.filter((x) => roleOf(product(x.id)) === "em");
  if (!core) return;
  const w = core.w + em.reduce((a, x) => a + x.w, 0), have = [core, ...em].reduce((a, x) => a + (x.have || 0), 0);
  PF.items = PF.items.filter((x) => x !== core && !em.includes(x));
  PF.items.push({ id: B.world, w, c: core.c, have: have || null });
  roundWeights();
  membersChanged();
}

// ---------------------------------------------------------------- purchase plan for the monthly saving
const buyPlan = (have, w, M) => I.buyPlan(have, w, M);
const monthsToTarget = (have, w, M) => I.monthsToTarget(have, w, M);
/** Whole kroner that sum to M. */
function roundKr(xs, M) {
  const fl = xs.map((x) => Math.floor(x)), rest = Math.round(M) - fl.reduce((a, b) => a + b, 0);
  xs.map((x, i) => [x - fl[i], i]).sort((a, b) => b[0] - a[0]).slice(0, Math.max(0, rest)).forEach(([, i]) => { fl[i] += 1; });
  return fl;
}
function renderBuyPlan() {
  const card = $("pf-plan-card"), M = PF.plan.monthly, n = PF.items.length;
  card.hidden = !n || !(M > 0);
  if (card.hidden) return;
  const s = sumW() || 1, w = PF.items.map((x) => x.w / s), have = PF.items.map((x) => (ok(x.have) ? x.have : 0));
  const anyHave = have.some((x) => x > 0);
  const fixed = roundKr(w.map((x) => x * M), M);
  const buy = anyHave ? roundKr(buyPlan(have, w, M), M) : fixed;
  const months = anyHave ? monthsToTarget(have, w, M) : 0;
  const H = have.reduce((a, b) => a + b, 0);
  $("buy-lead").innerHTML = !anyHave
    ? `Med ${kr(M)} i måneden setter du opp én spareavtale med beløpene under. Skriv inn hva du eier i dag i hvert fond i steg 3, så viser vi hvordan du når fordelingen uten å selge.`
    : months === 0 ? `Porteføljen er allerede i mål. Bruk den faste spareavtalen under, så holder fordelingen seg.`
    : `Kjøp for beløpene i kolonnen «Neste måned». ${ok(months) ? `Med ${kr(M)} i måneden er du innenfor 1 prosentpoeng av målet om <strong>${duration(months)}</strong>, uten å selge noe (før kursendringer).` : "Med dette sparebeløpet tar det svært lang tid å nå målet uten å selge. Vurder å flytte penger mellom fondene én gang."}`;
  table($("buy-table"), [{ t: "Fond / ETF" }, { t: "Eier i dag", num: true }, { t: "Mål", num: true }, { t: "Neste måned", num: true }, { t: "Fast spareavtale", num: true }],
    [...PF.items.map((it, i) => ({ cells: [{ html: swatch(it) + esc(product(it.id).name) }, anyHave ? `${kr(have[i])} (${pc0(H > 0 ? have[i] / H : 0)})` : "–", pc0(w[i]), { html: `<strong>${kr(buy[i])}</strong>` }, kr(fixed[i])] })),
      { _cls: "total", cells: ["Sum", anyHave ? kr(H) : "–", "100 %", kr(M), kr(M)] }], { caption: "Kjøpsplan per måned" });
  $("buy-table").classList.add("stack-table");
  // distributing funds pay cash: the plan only holds if that money is invested again
  const dist = PF.items.map((it, i) => ({ p: product(it.id), base: anyHave ? have[i] : PF.plan.start * w[i] })).filter((x) => x.p.acc === false);
  const known = dist.filter((x) => ok(x.p.yield12) && x.p.yield12 > 0), unknown = dist.filter((x) => !(ok(x.p.yield12) && x.p.yield12 > 0));
  const yearly = known.reduce((a, x) => a + x.base * x.p.yield12, 0);
  $("buy-div").hidden = !dist.length;
  $("buy-div").innerHTML = !dist.length ? "" : `${dist.length === 1 ? `${esc(dist[0].p.name)} er utdelende og betaler` : `${dist.length} av fondene er utdelende og betaler`} utbytte som kontanter på kontoen.` +
    (yearly >= 1 ? ` Med utbyttet de siste 12 månedene blir det omtrent <strong>${kr(yearly)} i året</strong>, ${kr(yearly / 12)} i måneden i snitt${anyHave ? "" : ` for ${kr(PF.plan.start)}`}.` : "") +
    (unknown.length ? ` For ${listNo(unknown.map((x) => esc(x.p.name)))} har vi ikke utbyttet.` : "") +
    " Kjøp for utbyttet når det kommer, fordelt som i kolonnen «Neste måned». Ellers blir avkastningen lavere enn tallene på siden.";
  $("buy-note").textContent = "«Neste måned» fyller opp fondene som ligger mest under målet. «Fast spareavtale» er fordelingen når du er i mål. " +
    (PF.items.some((x) => product(x.id).kind === "etf") ? "ETF-er kan spares månedlig uten kurtasje hos Nordnet bare hvis ETF-en er med i utvalget for spareavtale; sjekk det hos Nordnet. " : "") +
    "Kursendringer flytter fordelingen, så se på planen igjen et par ganger i året.";
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
  res.sum = {};
  PF.res = res;
  renderCharts();
}

function renderCharts() {
  if (!PF.res) return;
  PF.res.sum ||= {};
  renderKpis(); renderOwn(); renderTwins(); renderCost(); renderRisk(); renderOutcomes(); renderSuggestion(); renderMap(); renderSummary();
}

function grossReturn() {
  const res = PF.res;
  if (ok(PF.plan.ret)) return PF.plan.ret / 100;
  const g = res?.model ? res.model.now.ret + res.cost : 0.06;
  return Math.round(g * 200) / 200;                 // nearest half percent
}

/** Callout with the main finding of a section (vv-callout--insight). */
function callout(id, html) { $(id).innerHTML = `${ICON.insight.replace("<svg ", '<svg class="vv-callout__icon" ')}<div class="vv-callout__body">${html}</div>`; }
function vkpi(label, value, unit, range, meta, extra = "") {
  return `<div class="vv-kpi"><span class="vv-kpi__label">${label}</span><span class="vv-kpi__value">${value}${unit ? `<span class="vv-kpi__unit">${unit}</span>` : ""}</span>
    ${extra}${range ? `<span class="vv-kpi__range">${range}</span>` : ""}${meta ? `<span class="vv-kpi__meta">${meta}</span>` : ""}</div>`;
}
/** The simulated outcomes behind the fan, computed once per analysis. */
function projOf(res) {
  const m = res.model?.now, pl = PF.plan;
  if (!m) return null;
  const key = `${pl.start}|${pl.monthly}|${pl.years}`;
  if (!res.proj || res.projKey !== key) { res.proj = I.projection(pl.start, pl.monthly, pl.years, m.ret, m.vol, 4000); res.projKey = key; }
  return res.proj;
}
const RISK_LEVEL = (vol) => (vol < 0.015 ? "Svært lavt" : vol < 0.05 ? "Lavt" : vol < 0.09 ? "Middels" : vol < 0.135 ? "Høyt" : "Svært høyt");
function renderKpis() {
  const res = PF.res, m = res.model?.now, st = res.story, pl = PF.plan, pr = projOf(res), n = pl.years;
  const drag = planValue(0) - planValue(res.cost);
  const vol = m?.vol, pos = ok(vol) ? Math.min(1, vol / 0.25) : null;
  const meter = ok(pos) ? `<span class="meter" aria-hidden="true"><span class="meter-dot" style="left:${(pos * 100).toFixed(1)}%"></span></span>
    <span class="meter-scale" aria-hidden="true"><span>Bankkonto</span><span>Balansert</span><span>Enkeltbransje</span></span>` : "";
  $("pf-kpis").innerHTML = [
    vkpi("Forventet avkastning", m ? pct(m.ret) : "–", m ? "per år" : "",
      pr ? `Om ${n} år: ${krRound(pr.p10[n])} til ${krRound(pr.p90[n])}, mest sannsynlig ${krRound(pr.p50[n])}` : "",
      "Anslag etter kostnader, ikke et løfte. Spennet dekker 8 av 10 utfall."),
    vkpi("Verste år", st ? pct(st.worst.ret, 0) : "–", "", st ? `100 000 kr ble til ${krRound(100000 * (1 + st.worst.ret))}` : "for kort historikk",
      st ? `${mName(st.worst.from)} til ${mName(st.worst.to)}` : ""),
    vkpi("Kostnad", `${nf(2).format(res.cost * 100)}\u00a0%`, "per år", `${kr(pl.start * res.cost)} i år av ${kr(pl.start)}`, `${krRound(drag)} over ${n} år`),
    vkpi("Risikonivå", ok(vol) ? RISK_LEVEL(vol) : "–", "", ok(vol) ? `Svinger rundt ${pct(vol, 0)} i året` : "",
      ok(m?.sharpe) ? `Avkastning for risikoen (<a href="#ord-sharpe">Sharpe</a>): ${sharpeWord(m.sharpe)}` : "", meter),
  ].join("");
  $("pl-ret").placeholder = nf(1).format(grossReturn() * 100);
  $("pl-ret-help").textContent = `Brukes bare i kroneregnestykkene for kostnad og tvillinger. Står feltet tomt, brukes anslaget for porteføljen din (${nf(1).format(grossReturn() * 100)}\u00a0%).`;
  mixbar("pf-mix", res.use.map((u) => ({ label: u.p.name, w: u.w, tok: tokOf(u.item) })));
  $("pf-mix-legend").innerHTML = res.use.map((u) => `<div>${swatch(u.item)}<span class="nm">${esc(u.p.name)}</span><span class="val">${pc0(u.w)}</span></div>`).join("");
}

// ---------------------------------------------------------------- 1. what do I own
/** Ranked horizontal bars in one colour, value at the end. Returns HTML. */
function bars(rows, opt = {}) {
  const max = Math.max(...rows.map((r) => r[1]), 1e-9);
  return rows.length ? `<div class="bars">${rows.map(([name, v, sub]) => `<div class="bar-row"><span class="nm" title="${esc(name)}">${esc(name)}${sub ? ` <span class="muted">${esc(sub)}</span>` : ""}</span>
    <span class="track"><span class="fill${name === "Resten" ? " rest" : ""}" style="width:${(v / max * 100).toFixed(1)}%"></span></span><span class="val">${nf(opt.d ?? 0).format(v * 100)}\u00a0%</span></div>`).join("")}</div>`
    : `<p class="muted">${esc(opt.empty || "Ingen data")}</p>`;
}
const barData = (name, head, rows, d = 1) => ({ name, head, rows: rows.map(([n, v]) => [n, cell(Math.round(v * 100 * 10 ** d) / 10 ** d, `${nf(d).format(v * 100)}\u00a0%`)]) });

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
  const res = PF.res, L = res.look;
  const noData = res.use.filter((u) => !holdingsOf(u.p.id));
  const src = `Nordnet (Morningstar-data)${PF.H.fetched ? `, hentet ${dateNo(PF.H.fetched)}` : ""}`;
  if (L.covered <= 0) {
    callout("own-lead", "Vi har ikke innholdet i disse fondene ennå.");
    ["fig-comp", "fig-reg", "fig-sec"].forEach((id) => figure(id, { title: "Ingen data", html: "" }));
    $("own-overlap").innerHTML = "";
    res.sum.own = { value: "–", text: "Vi har ikke innholdet i disse fondene ennå." };
    return;
  }
  const ast = L.ast, eqShare = (ast.Aksjer || 0) / L.covered, bondShare = ((ast.Obligasjoner || 0) + (ast.Kontanter || 0)) / L.covered;
  const comps = mergedCompanies(L.companies), top10 = comps.slice(0, 10), top10w = top10.reduce((a, c) => a + c.w, 0);
  const us = top10.filter((c) => c.cc === "US").length;
  const regs = Object.entries(L.reg).sort((a, b) => b[1] - a[1]);
  const secs = Object.entries(L.sec).sort((a, b) => b[1] - a[1]);
  const rName = (k) => REGION[k] || k;
  const mix = [`${pc0(eqShare)} aksjer`];
  if (bondShare >= 0.005) mix.push(`${pc0(bondShare)} renter`);
  const oth = 1 - eqShare - bondShare; if (oth >= 0.01) mix.push(`${pc0(oth)} annet`);
  const conc = top10.length >= 5 && top10w >= 0.05;
  const first = conc
    ? `<strong>${pc0(top10w)}</strong> av pengene dine ligger i de samme ${top10.length} ${us >= 8 ? "amerikanske " : ""}selskapene, blant dem ${listNo(top10.slice(0, 3).map((c) => esc(c.name)))}.`
    : `Porteføljen er <strong>${listNo(mix)}</strong>.`;
  const second = (conc ? `Porteføljen er ${listNo(mix)}` : "Pengene er spredt på svært mange selskaper") +
    (regs.length ? `, og ${pc0(regs[0][1])} av aksjene er i ${esc(rName(regs[0][0]))}.` : ".");
  callout("own-lead", `<p>${first}</p><p>${second}</p>` +
    (noData.length ? `<p class="small-text">Mangler innhold for ${listNo(noData.map((u) => esc(u.p.name)))} (${pc0(1 - L.covered)} av porteføljen). De er ikke med i tallene.</p>` : ""));
  res.sum.own = conc ? { value: pc0(top10w), text: `av pengene ligger i de samme ${top10.length} selskapene` }
    : { value: pc0(eqShare), text: "av pengene er i aksjer, spredt på svært mange selskaper" };

  const about = [["Utvalg", "De 25–35 største beholdningene i hvert fond, vektet med andelene dine. Andelen i enkeltselskaper er derfor et minimum."],
    ["Metode", '<a href="#metode-innhold">Slik er tallene regnet</a>']];
  figure("fig-comp", top10.length ? {
    title: `De ${top10.length} største selskapene er ${pc0(top10w)} av porteføljen`,
    subtitle: "Andel av hele porteføljen, i prosent. Selskaper med flere aksjeklasser er slått sammen.",
    takeaway: top10w >= 0.25 ? "Går det dårlig for noen få av dem, merker du det godt." : "Det er vanlig for brede indeksfond. Resten er spredt på svært mange selskaper.",
    source: src, about, aria: `Søylediagram: de største selskapene i porteføljen. ${top10.slice(0, 3).map((c) => `${c.name} ${nf(1).format(c.w * 100)}\u00a0%`).join(", ")}.`,
    html: bars(top10.map((c) => [c.name, c.w]), { d: 1 }), data: barData("storste-selskaper", ["Selskap", "Andel av porteføljen (%)"], top10.map((c) => [c.name, c.w])),
  } : { title: "Fant ingen enkeltselskaper", subtitle: "Rentefond eier obligasjoner og bankinnskudd, ikke aksjer.", source: src, html: "" });

  const regRows = topRows(L.reg, 6).map(([k, v]) => [rName(k), v]), secRows = topRows(L.sec, 6);
  figure("fig-reg", {
    title: regs.length ? `${pc0(regs[0][1])} av aksjene er i ${esc(rName(regs[0][0]))}` : "Hvor i verden", subtitle: "Andel av aksjedelen, etter land og område.",
    source: src, about, aria: `Søylediagram: aksjene etter land og område. ${regRows.slice(0, 3).map(([n, v]) => `${n} ${pc0(v)}`).join(", ")}.`,
    html: bars(regRows, { empty: "Ingen aksjer i porteføljen" }), data: barData("land", ["Land eller område", "Andel av aksjene (%)"], regRows),
  });
  figure("fig-sec", {
    title: secs.length ? `Største bransje er ${esc(secs[0][0].toLowerCase())} med ${pc0(secs[0][1])}` : "Hvilke bransjer", subtitle: "Andel av aksjedelen, etter bransje.",
    source: src, about, aria: `Søylediagram: aksjene etter bransje. ${secRows.slice(0, 3).map(([n, v]) => `${n} ${pc0(v)}`).join(", ")}.`,
    html: bars(secRows, { empty: "Ingen aksjer i porteføljen" }), data: barData("bransjer", ["Bransje", "Andel av aksjene (%)"], secRows),
  });

  renderTree(comps, eqShare, bondShare, src);

  // the same thing twice?
  const pairs = [];
  for (let i = 0; i < res.use.length; i++) for (let j = i + 1; j < res.use.length; j++) {
    const sim = I.similarity(holdingsOf(res.use[i].p.id), holdingsOf(res.use[j].p.id));
    if (sim && (ok(sim.reg) || ok(sim.top))) pairs.push({ a: res.use[i].p, b: res.use[j].p, s: sim.score });
  }
  pairs.sort((x, y) => y.s - x.s);
  $("own-overlap-card").hidden = res.use.length < 2;
  const high = pairs.filter((x) => x.s >= 0.7);
  $("own-overlap").innerHTML = (high.length
    ? `<p><strong>Ja.</strong> ${high.length === 1 ? "To av fondene dine" : "Flere av fondene dine"} eier stort sett det samme. Du får ikke bedre spredning av å ha begge, så behold det billigste.</p>`
    : "<p><strong>Nei.</strong> Fondene dine eier nokså forskjellige ting, så de utfyller hverandre.</p>") +
    `<div class="bars">${pairs.slice(0, 8).map((x) => `<div class="bar-row pair"><span class="nm">${esc(x.a.name)} <span class="muted">og</span> ${esc(x.b.name)}</span>
      <span class="track"><span class="fill" style="width:${(x.s * 100).toFixed(0)}%"></span></span><span class="val">${pc0(x.s)} likt</span></div>`).join("")}</div>`;
}

/** Tile map of the whole portfolio: the largest companies, the rest of the shares, and interest. */
function renderTree(comps, eqShare, bondShare, src) {
  const top = comps.slice(0, 14), topSum = top.reduce((a, c) => a + c.w, 0);
  const labels = [], values = [], colors = [], text = [], ink = [];
  const add = (l, v, tok, t) => { if (v > 0.004) { labels.push(l); values.push(v * 100); colors.push(css(tok)); text.push(t || ""); ink.push(inkOn(tok)); } };
  top.forEach((c) => add(c.name, c.w, "--seq-4"));
  add("Resten av aksjene", Math.max(0, eqShare - topSum), "--seq-3", "spredt på svært mange selskaper");
  add("Renter og kontanter", bondShare, "--chart-2", "obligasjoner og bankinnskudd");
  add("Annet", Math.max(0, 1 - eqShare - bondShare), "--chart-context");
  figure("fig-tree", {
    title: "Slik er pengene plassert", subtitle: "Hver rute er en del av porteføljen, i prosent. Mørk blå: de 14 største selskapene. Blå: resten av aksjene. Turkis: renter og kontanter.",
    source: src, about: [["Utvalg", "De 25–35 største beholdningene i hvert fond, vektet med andelene dine. Selskaper utenfor dem ligger i «Resten av aksjene»."], ["Metode", '<a href="#metode-innhold">Slik er tallene regnet</a>']],
    aria: `Rutekart: ${labels.map((l, i) => `${l} ${nf(1).format(values[i])}\u00a0%`).slice(-3).join(", ")}.`,
    data: { name: "rutekart", head: ["Del av porteføljen", "Andel (%)"], rows: labels.map((l, i) => [l, cell(Math.round(values[i] * 10) / 10, `${nf(1).format(values[i])}\u00a0%`)]) },
  });
  if (!labels.length || !window.Plotly) return;
  plot("chart-tree", [{ type: "treemap", labels, parents: labels.map(() => ""), values, text, branchvalues: "total",
    marker: { colors, line: { color: css("--bg-000"), width: 2 }, pad: { t: 0, l: 0, r: 0, b: 0 } }, tiling: { pad: 2, packing: "squarify" },
    texttemplate: "<b>%{label}</b><br>%{value:.1f}\u00a0%", textfont: { family: FONT, color: ink, size: 13 }, textposition: "top left", sort: false,
    hovertemplate: "<b>%{label}</b><br>%{value:.1f}\u00a0% av porteføljen<br>%{text}<extra></extra>" }],
  layout({ margin: { l: 0, r: 0, t: 0, b: 0 }, uniformtext: { minsize: 10, mode: "hide" } }));
}

// ---------------------------------------------------------------- 2. cheaper twins + 3. cost in kroner
function planValue(cost, gross = grossReturn()) { return I.savingsValue(PF.plan.start, PF.plan.monthly, PF.plan.years, gross, cost); }

/** Kroner more after the plan if the share `w` (0..1) held in p moved to c: the yearly cost is lower, but an ETF in another
 *  currency than NOK pays currency exchange on every purchase. Monthly purchases of ETFs are assumed to go through Nordnet's
 *  monthly savings agreement, which has no brokerage fee; the money already in p is moved once. */
function twinGain(p, c, w) {
  const pl = PF.plan, g = grossReturn();
  const fx = (x) => (x.kind === "etf" && x.currency && x.currency !== "NOK" ? ETF_FX : 0);
  const fc = fx(c), fp = fx(p);
  return I.savingsValue(pl.start * w * (1 - fc), pl.monthly * w * (1 - fc), pl.years, g, (c.cost ?? 0) / 100)
    - I.savingsValue(pl.start * w, pl.monthly * w * (1 - fp), pl.years, g, (p.cost ?? 0) / 100);
}
/** Per fund in the portfolio: its twins with the gain in kroner, best first (only those that leave you with more). */
function twinPicks() {
  const res = PF.res, key = `${PF.plan.start}|${PF.plan.monthly}|${PF.plan.years}|${grossReturn()}`;
  if (res.picks && res.picksKey === key) return res.picks;
  res.picks = res.use.map((u, k) => res.twins[k].map((t) => ({ ...t, gain: twinGain(u.p, t.p, u.w) })).filter((t) => t.gain > 0).sort((a, b) => b.gain - a.gain));
  res.picksKey = key;
  return res.picks;
}
function renderTwins() {
  const res = PF.res, yrs = PF.plan.years, picks = twinPicks();
  const name = (p) => (p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name));
  const costTxt = (p) => (ok(p.cost) ? nf(2).format(p.cost) + "\u00a0%" : "–");
  let anyEtf = false, nTw = 0;
  const rows = res.use.map((u, k) => {
    const tw = picks[k], p = u.p;
    const own = `<th scope="row" class="tw-own">${esc(p.name)}<span class="small-text muted">${pc0(u.w)} av porteføljen, ${costTxt(p)} per år</span></th>`;
    if (!tw.length) {
      const any = twinsOf(p.id, { all: true }).length, fxEats = res.twins[k].length > 0;
      const why = fxEats ? "Tvillingene koster mindre per år, men valutavekslingen ved hvert kjøp tar igjen forskjellen for sparingen din."
        : any ? "Dette er allerede den billigste av tvillingene vi finner." : holdingsOf(p.id) || isRate(p) ? "Vi finner ingen billigere fond eller ETF-er med nesten samme innhold." : "Vi har ikke innholdet i dette fondet, så vi kan ikke lete etter tvillinger.";
      return `<tr>${own}<td colspan="4" class="tw-none">${any ? `<span class="vv-badge">${ICON.check}Billigst allerede</span> ` : ""}<span class="small-text">${why}</span></td></tr>`;
    }
    nTw++;
    // the cheapest, and as alternatives the next two and always the cheapest ordinary fund (no brokerage fee) if there is one
    const show = tw.slice(0, 3), fund = tw.find((t) => t.p.kind === "fond");
    if (fund && !show.includes(fund)) show[2] = fund;
    if (show.some((t) => t.p.kind === "etf")) anyEtf = true;
    const gain = (t) => t.gain;
    const t = show[0], more = show.slice(1);
    const sub = more.map((x) => {
      const d5 = ok(x.p.ret[5]) && ok(p.ret[5]) ? x.p.ret[5] - p.ret[5] : null;
      return `<tr><th scope="row">${name(x.p)}<span class="pf-badges"><span class="vv-badge">${esc(x.p.kindLabel)}</span><span class="vv-badge vv-badge--info">${esc(x.label)}</span></span></th>
        <td class="vv-num" data-label="Kostnad per år">${costTxt(x.p)}</td><td class="vv-num" data-label="Du sitter igjen med"><strong>${kr(gain(x))}</strong> mer</td>
        <td class="vv-num hide-narrow">${ok(x.p.ret[5]) ? pct(x.p.ret[5]) : "under 5 år"}${ok(d5) ? ` <span class="muted">(${pp(d5)})</span>` : ""}</td>
        <td><button type="button" class="vv-btn vv-btn--secondary" data-swap="${esc(p.id)}" data-with="${esc(x.p.id)}">Bytt</button></td></tr>`;
    }).join("");
    return `<tr>${own}
      <td data-label="Beste tvilling">${name(t.p)}<span class="pf-badges"><span class="vv-badge">${esc(t.p.kindLabel)}</span><span class="vv-badge vv-badge--info">${esc(t.label)}</span></span></td>
      <td class="vv-num" data-label="Kostnad per år">${costTxt(t.p)}<span class="small-text muted">mot ${costTxt(p)}</span></td>
      <td class="vv-num" data-label="Du sitter igjen med"><strong>${kr(gain(t))}</strong><span class="small-text muted">mer etter ${yrs} år</span></td>
      <td class="tw-actions"><button type="button" class="vv-btn vv-btn--secondary" data-swap="${esc(p.id)}" data-with="${esc(t.p.id)}" aria-label="Bytt ${esc(p.name)} med ${esc(t.p.name)}">Bytt</button>
        ${more.length ? `<button type="button" class="vv-btn vv-btn--ghost" data-more aria-expanded="false" aria-controls="tw-more-${k}">Vis flere alternativer</button>` : ""}</td></tr>
      ${more.length ? `<tr class="tw-more" id="tw-more-${k}" hidden><td colspan="5"><table class="vv-table tw-sub stack-table"><caption class="small-text">Andre tvillinger til ${esc(p.name)}</caption>
        <thead><tr><th scope="col">Tvilling</th><th scope="col" class="vv-num">Kostnad per år</th><th scope="col" class="vv-num">Du sitter igjen med etter ${yrs} år</th><th scope="col" class="vv-num hide-narrow">Avkastning per år, 5 år</th><th scope="col"><span class="visually-hidden">Bytt</span></th></tr></thead>
        <tbody>${sub}</tbody></table></td></tr>` : ""}`;
  }).join("");
  $("twins").innerHTML = `<thead><tr><th scope="col">Fondet ditt</th><th scope="col">Beste tvilling</th><th scope="col" class="vv-num">Kostnad per år</th><th scope="col" class="vv-num">Du sitter igjen med</th><th scope="col"><span class="visually-hidden">Handling</span></th></tr></thead><tbody>${rows}</tbody>`;
  $("twins").classList.add("stack-table");
  const save = picks.reduce((a, tw) => a + (tw[0]?.gain || 0), 0);
  if (save > 500) {
    callout("twin-lead", `<p>Bytter du til tvillingene i tabellen, sitter du igjen med <strong>${krRound(save)} mer</strong> etter ${yrs} år.</p>
      <p>${nTw === res.use.length ? (nTw === 1 ? "Fondet ditt har" : `Alle de ${nTw} fondene har`) : `${nTw} av ${res.use.length} fond har`} en billigere tvilling med nesten samme innhold.</p>`);
    res.sum.twin = { value: krRound(save), text: `mer etter ${yrs} år med billigere tvillinger` };
  } else {
    callout("twin-lead", "<p>Du har allerede de billigste fondene vi finner for dette innholdet.</p>");
    res.sum.twin = { value: "0 kr", text: "å spare: du har allerede de billigste fondene vi finner" };
  }
  $("twin-note").textContent = "Tvillinger eier nesten det samme som fondet ditt i dag, målt på land, bransjer og de største selskapene. «Du sitter igjen med» er hvor mye mer sparingen er verdt etter " +
    `${yrs} år med lavere kostnad.` + (anyEtf ? ` For ETF-er regner vi med månedlig spareavtale uten kurtasje (Nordnet tilbyr det for et utvalg ETF-er) og ${nf(2).format(ETF_FX * 100)}\u00a0% valutaveksling ved hvert kjøp i utenlandsk valuta. Kurtasje ved engangskjøp og salg og kursforskjell kommer i tillegg.` : "");
}

/** Yearly cost after moving to the best twins, and the kroner gained by it. */
function cheapestCost() {
  const res = PF.res, picks = twinPicks();
  return { cost: res.use.reduce((a, u, k) => a + u.w * ((picks[k][0]?.p.cost ?? u.p.cost ?? 0)), 0) / 100, gain: picks.reduce((a, tw) => a + (tw[0]?.gain || 0), 0) };
}

function renderCost() {
  const res = PF.res, pl = PF.plan, g = grossReturn();
  const paid = pl.start + pl.monthly * 12 * pl.years;
  const v0 = planValue(0), v1 = planValue(res.cost), best = cheapestCost(), cheap = best.cost;
  const hasTwin = best.gain > 500;
  const saving = [pl.start > 0 ? `${kr(pl.start)} i dag` : "", pl.monthly > 0 ? `${kr(pl.monthly)} i måneden` : ""].filter(Boolean).join(" og ");
  callout("cost-lead", `<p>Kostnadene tar <strong>${krRound(v0 - v1)}</strong> av sparingen din over ${pl.years} år.</p>
    <p>${hasTwin ? `Med de beste tvillingene (${nf(2).format(cheap * 100)}\u00a0% per år) sitter du igjen med ${krRound(best.gain)} mer.` : "Du betaler allerede lite for dette innholdet."}</p>`);
  res.sum.cost = { value: krRound(v0 - v1), text: `tar kostnadene av sparingen over ${pl.years} år (${nf(2).format(res.cost * 100)}\u00a0% per år)` };

  const ys = Array.from({ length: pl.years + 1 }, (_, y) => y);
  const val = (cost) => ys.map((y) => I.savingsValue(pl.start, pl.monthly, y, g, cost));
  const c0 = val(0), c1 = val(res.cost), paidY = ys.map((y) => pl.start + pl.monthly * 12 * y);
  const line = (name, y, color, width, extra = {}) => ({ type: "scatter", mode: "lines", name, x: ys, y, line: { color, width }, hovertemplate: `${name}: %{y:,.0f}\u00a0kr<extra></extra>`, ...extra });
  const end = (y, text) => ({ x: pl.years, y, text, showarrow: false, xanchor: "left", yanchor: "middle", xshift: 8, align: "left", font: { family: FONT, size: 12, color: css("--ink-900") } });
  figure("fig-cost", {
    title: `Kostnadene tar ${krRound(v0 - v1)} over ${pl.years} år`,
    subtitle: `Verdien av sparingen i kroner, med og uten kostnader. ${saving || "0 kr"} i ${pl.years} år og ${nf(1).format(g * 100)}\u00a0% avkastning per år før kostnader.`,
    takeaway: `Med dagens kostnad på ${nf(2).format(res.cost * 100)}\u00a0% per år blir sparingen ${krRound(v1)}. Helt uten kostnader ville den blitt ${krRound(v0)}. Gapet vokser fordi du også mister avkastningen på pengene kostnadene tar.`,
    source: "Nordnet (kostnader per fond), egne beregninger",
    about: [["Kostnad", "Fond: Nordnets totalkostnad (forvaltning − returprovisjon + plattformavgift). ETF-er: årlig kostnad (TER). Kurtasje og valutapåslag er ikke med."],
      ["Avkastning", ok(pl.ret) ? "Satt av deg under «Avanserte innstillinger»." : "Anslaget for porteføljen din, rundet til nærmeste halve prosent. Kan endres under «Avanserte innstillinger»."],
      ["Metode", '<a href="#metode-kostnad">Slik er tallene regnet</a>']],
    aria: `Linjediagram: sparingen vokser til ${krRound(v1)} med kostnader og ${krRound(v0)} uten, et gap på ${krRound(v0 - v1)} etter ${pl.years} år.`,
    data: { name: "kostnad-over-tid", head: ["År", "Satt inn (kr)", "Porteføljen din (kr)", "Uten kostnader (kr)"],
      rows: ys.map((y) => [String(y), cell(Math.round(paidY[y]), kr(paidY[y])), cell(Math.round(c1[y]), kr(c1[y])), cell(Math.round(c0[y]), kr(c0[y]))]) },
  });
  plot("chart-cost", [
    line("Det du har satt inn", paidY, css("--chart-reference"), 1.5),
    line("Porteføljen din", c1, css("--chart-focus"), 2.5),
    line("Uten kostnader", c0, css("--chart-context"), 1.5, { fill: "tonexty", fillcolor: css("--chart-context") }),
  ], layout({
    showlegend: false, hovermode: "x unified", margin: { l: 8, r: 128, t: 12, b: 40 },
    xaxis: axis({ ticksuffix: " år", dtick: pl.years > 12 ? 5 : pl.years > 5 ? 2 : 1, range: [0, pl.years] }),
    yaxis: axis({ tickformat: ",.0f", ticksuffix: " kr", nticks: 5, rangemode: "tozero" }),
    annotations: [end(v0, `Uten kostnader<br><b>${krRound(v0)}</b>`), end(v1 - (v0 - v1 < v0 * 0.06 ? v0 * 0.08 : 0), `Porteføljen din<br><b>${krRound(v1)}</b>`), end(paid, `Satt inn<br><b>${krRound(paid)}</b>`),
      { x: pl.years * 0.97, y: (c0[pl.years] + c1[pl.years]) / 2, text: `Kostnader: <b>${krRound(v0 - v1)}</b>`, showarrow: false, xanchor: "right", yanchor: "bottom", yshift: 4, font: { family: FONT, size: 12, color: css("--ink-900") } }],
  }));

  const drag = v0 - v1, wc = res.use.map((u) => u.w * (u.p.cost ?? 0)), sum = wc.reduce((a, b) => a + b, 0) || 1;
  table($("cost-table"), [{ t: "Fond / ETF" }, { t: "Andel", num: true }, { t: "Kostnad per år", num: true }, { t: "I år", num: true }, { t: `Over ${pl.years} år`, num: true }],
    [...res.use.map((u, k) => ({ cells: [u.p.name, pc0(u.w), ok(u.p.cost) ? nf(2).format(u.p.cost) + "\u00a0%" : "–", kr(pl.start * u.w * (u.p.cost ?? 0) / 100), krRound(drag * wc[k] / sum)] })),
      { _cls: "total", cells: ["Sum", "100 %", nf(2).format(res.cost * 100) + "\u00a0%", kr(pl.start * res.cost), krRound(drag)] }], { caption: "Kostnad per fond" });
  $("cost-note").textContent = `«Over ${pl.years} år» er hvor mye mindre du sitter igjen med enn om fondene var gratis: både det du betaler og avkastningen du går glipp av på de pengene.`;
}

// ---------------------------------------------------------------- 4. risk as a story
function renderRisk() {
  const res = PF.res, st = res.story;
  if (!st) {
    const msg = res.missing.length ? `Mangler kursdata for ${listNo(res.missing.map((u) => esc(u.p.name)))}.` : "For kort felles historikk til å si noe om risiko.";
    callout("risk-lead", `<p>${msg}</p>`);
    figure("fig-risk", { title: "Ingen historikk å vise" }); emptyChart("chart-risk", "Ingen historikk å vise");
    figure("fig-years", { title: "Ingen historikk å vise" }); emptyChart("chart-years", "Ingen historikk å vise");
    figure("fig-contrib", { title: "Ingen historikk å vise", html: "" });
    $("risk-kpis").innerHTML = "";
    res.sum.risk = { value: "–", text: msg };
    return;
  }
  const f = st.fall, K = 100000;
  const back = f.recovered !== null ? `Etter det største fallet tok det ${duration(f.monthsBack)} fra bunnen før pengene var tilbake.`
    : `Etter det største fallet er porteføljen ennå ikke tilbake, ${duration(f.monthsSinceTrough)} etter bunnen.`;
  const est = res.use.filter((u) => u.ser.kind !== "own");
  const years = res.months / 12;
  callout("risk-lead", `<p>I det verste året ville 100 000 kr blitt til <strong>${krRound(K * (1 + st.worst.ret))}</strong> (${mName(st.worst.from)} til ${mName(st.worst.to)}).</p><p>${back}</p>`);
  res.sum.risk = { value: pct(st.worst.ret, 0), text: `i det verste året: 100 000 kr ble til ${krRound(K * (1 + st.worst.ret))}` };

  const dates = [], vals = [];
  for (let k = 0; k <= res.months; k++) { dates.push(monthEnd(res.from - 1 + k)); vals.push(st.values[k] * K); }
  const b = benchSeries(), traces = [];
  let bv = null;
  const bName = D.by[st_bench()]?.ticker || "referanse";
  if (b && E.isNum(b[res.from])) {
    bv = E.cumulative(b, res.from, D.end, K);
    traces.push({ x: dates, y: bv, mode: "lines", name: `Verdensindeksen (${bName})`, line: { color: css("--chart-context"), width: 1.5 }, hovertemplate: "%{y:,.0f}\u00a0kr<extra>Verdensindeksen</extra>" });
  }
  traces.push({ x: dates, y: vals, mode: "lines", name: "Porteføljen din", line: { color: css("--chart-focus"), width: 2.5 }, hovertemplate: "%{y:,.0f}\u00a0kr<extra>Porteføljen din</extra>" });
  const d = (i) => monthEnd(i), endX = f.recovered !== null ? d(f.recovered) : dates[dates.length - 1];
  const useLog = Math.max(...vals) / Math.min(...vals) > 5;
  const vAt = (i) => st.values[i - res.from + 1] * K;
  const tr = (v) => (useLog ? Math.log10(v) : v);
  const lastX = dates[dates.length - 1];
  const ends = [{ x: lastX, y: tr(vals[vals.length - 1]), text: "<b>Porteføljen din</b>", xanchor: "right", yanchor: "bottom", showarrow: false, font: { family: FONT, size: 12, color: css("--ink-900") } }];
  if (bv) ends.push({ x: lastX, y: tr(bv[bv.length - 1]), text: "Verdensindeksen", xanchor: "right", yanchor: bv[bv.length - 1] > vals[vals.length - 1] ? "bottom" : "top", showarrow: false, font: { family: FONT, size: 12, color: css("--ink-700") } });
  figure("fig-risk", {
    title: `Største fall: ${pct(f.depth, 0)}, ${f.recovered !== null ? `tilbake etter ${duration(f.monthsDown + f.monthsBack)}` : "ikke tilbake ennå"}`,
    subtitle: `Verdien av 100 000 kr satt inn i ${mName(res.from)}, med fast fordeling, i kroner etter fondenes kostnader. Skyggelagt: fra toppen før det største fallet til pengene var tilbake.${useLog ? " Loggskala, så like store prosentvise endringer blir like høye." : ""}`,
    takeaway: `I et vanlig år har porteføljen gitt rundt ${pct(st.median, 0)}, og ${nf(0).format(Math.round(st.negShare * 10))} av 10 tolvmånedersperioder har endt i minus. Det beste året ga ${pct(st.best.ret, 0)}.` +
      (years < 12 ? " Perioden er kort, så over lengre tid må du regne med verre år enn dette." : ""),
    source: "Yahoo Finance (ETF-kurser), Nordnet (fondenes avkastning og risiko), Norges Bank (valuta), egne beregninger",
    about: [["Periode", `${nf(0).format(Math.floor(years))} år, ${mName(res.from)} til ${mName(D.end)}, månedlige tall.`],
      ["Anslått historikk", est.length ? `Fond har ikke kurshistorikk hos oss. For ${listNo(est.map((u) => esc(u.p.name)))} er månedene anslått ut fra markedet fondet investerer i, justert til fondets egen avkastning og risiko.` : "Ingen: alle har egne kurser."],
      ["Referanse", `Verdensindeksen: ${esc(D.by[st_bench()]?.name || "referansen")}.`], ["Metode", '<a href="#metode-risiko">Slik er tallene regnet</a>']],
    aria: `Linjediagram: verdien av 100 000 kr i porteføljen fra ${mName(res.from)}. Største fall ${pct(f.depth, 0)} fra ${mName(f.peak)} til ${mName(f.trough)}.`,
    data: { name: "verdiutvikling", head: ["Måned", "Porteføljen din (kr)", ...(bv ? ["Verdensindeksen (kr)"] : [])],
      rows: dates.map((x, i) => [x.slice(0, 7), cell(Math.round(vals[i]), kr(vals[i])), ...(bv ? [cell(Math.round(bv[i]), kr(bv[i]))] : [])]) },
  });
  plot("chart-risk", traces, layout({
    showlegend: false, hovermode: "x unified", margin: { l: 72, r: 16, t: 36, b: 40 },
    xaxis: axis({ type: "date", tickformat: "%Y", range: [dates[0], dates[dates.length - 1]] }),
    yaxis: axis({ tickformat: ",.0f", ticksuffix: " kr", type: useLog ? "log" : "linear" }),
    shapes: [{ type: "rect", xref: "x", yref: "paper", x0: d(f.peak), x1: endX, y0: 0, y1: 1, fillcolor: css("--band-focus"), line: { width: 0 }, layer: "below" }],
    annotations: [
      { x: d(f.trough), y: tr(vAt(f.trough)), text: `Bunn ${mName(f.trough)}<br><b>${pct(f.depth, 0)}</b>`, showarrow: true, arrowhead: 0, arrowcolor: css("--ink-500"), ax: 0, ay: 34, font: { family: FONT, size: 12, color: css("--ink-900") } },
      { x: d(f.peak), y: 1, yref: "paper", text: `Største fall${f.recovered !== null ? `, tilbake etter ${duration(f.monthsDown + f.monthsBack)}` : ", ikke tilbake ennå"}`, showarrow: false, xanchor: "left", yanchor: "bottom", font: { family: FONT, size: 12, color: css("--ink-700") } },
      ...ends,
    ],
  }));
  $("risk-kpis").innerHTML = [
    vkpi("Verste år", pct(st.worst.ret, 0), "", "", `${mName(st.worst.from)} til ${mName(st.worst.to)}`),
    vkpi("Største fall", pct(f.depth, 0), "", "", `${mName(f.peak)} til ${mName(f.trough)} (${duration(f.monthsDown)})`),
    vkpi("Tid tilbake", f.recovered !== null ? duration(f.monthsBack) : "ikke tilbake", "", "", "fra bunnen til gammel topp"),
    vkpi("Et dårlig år", pc0(st.bad), "", "", "ett av ti år har vært verre"),
    vkpi("Et vanlig år", pct(st.median, 0), "", "", "den midterste tolvmånedersperioden"),
    vkpi("Beste år", pct(st.best.ret, 0), "", "", `${mName(st.best.from)} til ${mName(st.best.to)}`),
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
  const v = yrs.map((x) => (x.g - 1) * 100), full = yrs.filter((x) => x.n === 12), pos = full.filter((x) => x.g >= 1).length;
  const lbl = (x) => `${x >= 0 ? "+" : "−"}${nf(0).format(Math.abs(x))}\u00a0%`;
  figure("fig-years", {
    title: `${pos} av ${full.length} hele kalenderår ga pluss`,
    subtitle: "Avkastning per kalenderår i prosent, i kroner etter kostnader. Første og siste år kan være delvise. Blått over null, oransje under.",
    source: "Yahoo Finance, Nordnet, egne beregninger",
    about: [["Periode", `${mName(res.from)} til ${mName(D.end)}, med fast fordeling.`], ["Metode", '<a href="#metode-risiko">Slik er tallene regnet</a>']],
    aria: `Søylediagram: avkastning per kalenderår. ${pos} av ${full.length} år ga pluss. Verste ${lbl(Math.min(...v))}, beste ${lbl(Math.max(...v))}.`,
    data: { name: "ar-for-ar", head: ["År", "Avkastning (%)", "Måneder"], rows: yrs.map((x, i) => [String(x.y), cell(Math.round(v[i] * 10) / 10, lbl(v[i])), String(x.n)]) },
  });
  plot("chart-years", [{ type: "bar", x: yrs.map((x) => String(x.y)), y: v, marker: { color: v.map((x) => (x >= 0 ? css("--div-pos-2") : css("--div-neg-2"))), line: { width: 0 } },
    customdata: yrs.map((x) => (x.n < 12 ? ` (${x.n} måneder)` : "")), hovertemplate: "%{x}%{customdata}: %{y:.1f}\u00a0%<extra></extra>",
    text: v.map((x) => `${x >= 0 ? "+" : "−"}${nf(0).format(Math.abs(x))}`), textposition: "outside", textfont: { family: FONT, size: 11, color: css("--ink-900") }, constraintext: "none", cliponaxis: false }],
  layout({ showlegend: false, bargap: 0.25, margin: { l: 44, r: 8, t: 20, b: 32 }, uniformtext: { minsize: 9, mode: "hide" },
    xaxis: axis({ type: "category", tickangle: 0, nticks: 8 }), yaxis: axis({ ticksuffix: " %", zeroline: true, zerolinewidth: 1, zerolinecolor: css("--ink-500") }) }));
  // money vs swings
  const rc = res.model?.rc;
  if (!rc) { figure("fig-contrib", { title: "Hvem står for svingningene?", html: '<p class="muted">For kort historikk.</p>' }); return; }
  const mx = Math.max(...rc, ...res.use.map((u) => u.w), 1e-9);
  const big = res.use.map((u, k) => ({ u, k, d: rc[k] - u.w })).sort((a, b) => b.d - a.d)[0];
  const html = `<ul class="vv-legend contrib-legend"><li><span class="vv-legend__swatch" style="background:${css("--chart-context")}"></span>Andel av pengene</li>
      <li><span class="vv-legend__swatch" style="background:${css("--chart-focus")}"></span>Andel av svingningene</li></ul>` +
    res.use.map((u, k) => `<div class="contrib-row"><div class="nm">${esc(u.p.name)}</div>
      <div class="pair"><span class="lbl">Penger</span><span class="track"><span class="fill money" style="width:${(u.w / mx * 100).toFixed(1)}%"></span></span><span class="val">${pc0(u.w)}</span></div>
      <div class="pair"><span class="lbl">Risiko</span><span class="track"><span class="fill risk" style="width:${(Math.max(0, rc[k]) / mx * 100).toFixed(1)}%"></span></span><span class="val">${pc0(rc[k])}</span></div></div>`).join("");
  const loud = big && big.d > 0.05;
  figure("fig-contrib", {
    title: loud ? `${esc(big.u.p.name)} står for ${pc0(rc[big.k])} av svingningene` : "Svingningene fordeler seg omtrent som pengene",
    subtitle: `Andel av pengene og andel av svingningene per fond, beregnet fra de siste ${nf(0).format(res.model.eMonths / 12)} årene.`,
    takeaway: loud ? `Fondet er ${pc0(big.u.w)} av pengene, men står for mer av uroen. Et lite fond kan svinge mye.` : "",
    source: "Egne beregninger fra månedsavkastning", html,
    about: [["Metode", "Hvert fonds bidrag til porteføljens varians: andelen ganger fondets samvariasjon med hele porteføljen, delt på porteføljens varians. Samvariasjonen er krympet med Ledoit-Wolf."], ["Mer", '<a href="#metode-forslag">Slik er tallene regnet</a>']],
    aria: `Søyler per fond: andel av pengene og andel av svingningene. ${res.use.map((u, k) => `${u.p.name}: ${pc0(u.w)} av pengene, ${pc0(rc[k])} av svingningene`).join(". ")}.`,
    data: { name: "svingninger-per-fond", head: ["Fond / ETF", "Andel av pengene (%)", "Andel av svingningene (%)"],
      rows: res.use.map((u, k) => [u.p.name, cell(Math.round(u.w * 1000) / 10, pc0(u.w)), cell(Math.round(rc[k] * 1000) / 10, pc0(rc[k]))]) },
  });
}

// ---------------------------------------------------------------- what can it become
function renderOutcomes() {
  const res = PF.res, m = res.model, pl = PF.plan;
  if (!m) { figure("fig-fan", { title: "For kort historikk til å anslå hva sparingen kan bli verdt" }); emptyChart("chart-fan", "Ingen anslag å vise"); return; }
  const pr = projOf(res), n = pl.years, ys = pr.paid.map((_, y) => y);
  const end = (y, text) => ({ x: n, y, text, showarrow: false, xanchor: "left", yanchor: "middle", xshift: 8, align: "left", font: { family: FONT, size: 12, color: css("--ink-900") } });
  const tr = (name, y, color, width, extra = {}) => ({ type: "scatter", mode: "lines", name, x: ys, y, line: { color, width }, hovertemplate: `${name}: %{y:,.0f}\u00a0kr<extra></extra>`, ...extra });
  figure("fig-fan", {
    title: `Om ${n} år er sparingen mest sannsynlig verdt rundt ${krRound(pr.p50[n])}`,
    subtitle: "Simulert verdi i kroner, etter kostnader, uten justering for prisvekst. Den mørke streken er det mest sannsynlige utfallet. Feltet dekker 8 av 10 utfall: under feltet er det ene av ti dårligste, over det ene av ti beste.",
    takeaway: `Går det dårlig, ender du på ${krRound(pr.p10[n])} eller mindre. Går det bra, blir det ${krRound(pr.p90[n])} eller mer. Du har da satt inn ${krRound(pr.paid[n])}` +
      (pr.p10[n] < pr.paid[n] ? ", så i de dårlige utfallene sitter du igjen med mindre enn du satte inn." : "."),
    source: "Egne beregninger",
    about: [["Grunnlag", `Forventet avkastning ${pct(m.now.ret)} og svingninger ${pct(m.now.vol)} per år, etter kostnader. 4 000 simulerte forløp.`], ["Metode", '<a href="#metode-vifte">Slik er tallene regnet</a>']],
    aria: `Viftediagram: om ${n} år mest sannsynlig ${krRound(pr.p50[n])}, mellom ${krRound(pr.p10[n])} og ${krRound(pr.p90[n])} i 8 av 10 utfall.`,
    data: { name: "hva-sparingen-kan-bli", head: ["År", "Satt inn (kr)", "Dårlig, 1 av 10 (kr)", "Mest sannsynlig (kr)", "Bra, 1 av 10 (kr)"],
      rows: ys.map((y) => [String(y), cell(Math.round(pr.paid[y]), kr(pr.paid[y])), cell(Math.round(pr.p10[y]), kr(pr.p10[y])), cell(Math.round(pr.p50[y]), kr(pr.p50[y])), cell(Math.round(pr.p90[y]), kr(pr.p90[y]))]) },
  });
  plot("chart-fan", [
    tr("Går det dårlig (1 av 10)", pr.p10, css("--band-focus"), 0.5),
    tr("Går det bra (1 av 10)", pr.p90, css("--band-focus"), 0.5, { fill: "tonexty", fillcolor: css("--band-focus") }),
    tr("Mest sannsynlig", pr.p50, css("--chart-focus"), 2.5),
    tr("Det du har satt inn", pr.paid, css("--chart-reference"), 1.5),
  ], layout({
    showlegend: false, hovermode: "x unified", margin: { l: 8, r: 150, t: 12, b: 40 },
    xaxis: axis({ ticksuffix: " år", dtick: n > 12 ? 5 : n > 5 ? 2 : 1, range: [0, n] }),
    yaxis: axis({ tickformat: ",.0f", ticksuffix: " kr", nticks: 6, rangemode: "tozero" }),
    annotations: [end(pr.p90[n], `Går det bra<br><b>${krRound(pr.p90[n])}</b>`), end(pr.p50[n], `Mest sannsynlig<br><b>${krRound(pr.p50[n])}</b>`),
      end(Math.min(pr.p10[n], pr.p50[n] - (pr.p90[n] - pr.p10[n]) * 0.13), `Går det dårlig<br><b>${krRound(pr.p10[n])}</b>`)],
  }));
}

// ---------------------------------------------------------------- 5. a better mix
function suggestion(risk = PF.risk) {
  const res = PF.res, m = res?.model;
  if (!m?.frontier) return null;
  const pts = m.frontier, lo = pts[0].vol, hi = Math.max(...pts.map((p) => p.vol));
  const cur = Math.max(lo, Math.min(hi, m.now.vol));
  const target = risk === "same" || !ok(risk) ? cur : lo + (hi - lo) * risk / 100;
  const raw = I.forRisk(pts, target);
  // whole percent, like the table above
  const fl = Array.from(raw, (x) => Math.floor(x * 100)), rest = 100 - fl.reduce((a, b) => a + b, 0);
  Array.from(raw, (x, i) => [x * 100 - fl[i], i]).sort((a, b) => b[0] - a[0]).slice(0, rest).forEach(([, i]) => { fl[i] += 1; });
  const w = Float64Array.from(fl, (x) => x / 100);
  return { w, perf: m.perf(w), lo, hi, cur, target, pos: hi > lo ? Math.round((target - lo) / (hi - lo) * 100) : 50,
    story: I.riskStory(res.mix(w), res.from, D.end) };
}

function renderSuggestion() {
  const res = PF.res, m = res.model;
  const sg = res.sg = suggestion();
  const same = PF.risk === "same" ? sg : suggestion("same");
  const changedAt = (x) => x && res.use.some((u, k) => Math.abs(x.w[k] - u.w) >= 0.015);
  res.sum.better = !same ? { value: "–", text: res.use.length < 2 ? "Legg til minst to fond, så foreslår vi en bedre fordeling" : "Vi mangler historikk til å foreslå en fordeling" }
    : !changedAt(same) ? { value: "Allerede god", text: "Vi finner ingen bedre fordeling av disse fondene med samme risiko" }
    : { value: pp(same.perf.ret - m.now.ret), text: "høyere forventet avkastning med samme risiko, bare ved å endre andelene" };
  const off = (msg) => { callout("sg-lead", `<p>${msg}</p>`); $("sg-table").innerHTML = ""; $("sg-bars").innerHTML = ""; $("sg-risk-now").textContent = ""; $("sg-apply").disabled = true; figure("fig-map", { title: "Risiko og avkastning" }); };
  if (!sg) return off(res.use.length < 2 ? "Legg til minst to fond eller ETF-er, så foreslår vi hvordan pengene bør fordeles mellom dem."
    : "Vi mangler historikk for å kunne foreslå en fordeling for disse fondene.");
  const now = m.now, d = sg.perf.ret - now.ret, dv = sg.perf.vol - now.vol;
  const changed = changedAt(sg);
  $("sg-apply").disabled = !changed;
  $("sg-risk-now").textContent = `Porteføljen din svinger rundt ${pct(now.vol)} i året. Forslaget: ${pct(sg.perf.vol)}.`;
  const gainKr = planValue(0, sg.perf.ret) - planValue(0, now.ret);
  const riskTxt = Math.abs(dv) < 0.004 ? "med samme risiko som i dag" : dv < 0 ? "med lavere risiko enn i dag" : "med høyere risiko enn i dag";
  callout("sg-lead", !changed
    ? "<p>Fordelingen din er allerede omtrent så god som den kan bli med disse fondene og denne risikoen.</p><p>Vil du ha mer eller mindre risiko, endre aksjeandelen i steg 2.</p>"
    : `<p>Forslaget ${riskTxt} gir forventet avkastning på <strong>${pct(sg.perf.ret)}</strong> per år, mot ${pct(now.ret)} i dag (${pp(d)}).</p>` +
      `<p>${Math.abs(gainKr) >= 1000 ? `Det er omtrent ${krRound(Math.abs(gainKr))} ${gainKr >= 0 ? "mer" : "mindre"} etter ${PF.plan.years} år. ` : ""}Verste år i historikken: ${pct(sg.story?.worst.ret, 0)} (i dag ${pct(res.story.worst.ret, 0)}).</p>` +
      (res.capped?.length ? `<p class="small-text">Smale fond (${listNo(res.capped.map(esc))}) får aldri mer enn ${pc0(NARROW_CAP)} hver i forslaget, så ett fond som har gått bra ikke får dominere.</p>` : ""));
  $("sg-bars").innerHTML = '<div class="ba-row"><span>I dag</span><div class="mixbar" id="sg-bar-now" role="img"></div></div><div class="ba-row"><span>Forslag</span><div class="mixbar" id="sg-bar-new" role="img"></div></div>';
  mixbar("sg-bar-now", res.use.map((u) => ({ label: u.p.name, w: u.w, tok: tokOf(u.item) })));
  mixbar("sg-bar-new", res.use.map((u, k) => ({ label: u.p.name, w: sg.w[k], tok: tokOf(u.item) })));
  const row = (label, a, b, cls) => ({ _cls: cls || "", cells: [label, a, b, ""] });
  table($("sg-table"), [{ t: "Fond / ETF" }, { t: "I dag", num: true }, { t: "Forslag", num: true }, { t: "Endring", num: true }], [
    ...res.use.map((u, k) => { const dd = sg.w[k] - u.w; return { cells: [{ html: swatch(u.item) + esc(u.p.name) }, pc0(u.w), { html: `<strong>${pc0(sg.w[k])}</strong>` },
      { html: Math.abs(dd) < 0.005 ? '<span class="muted">uendret</span>' : `${dd > 0 ? "+" : "−"}${nf(0).format(Math.abs(dd) * 100)} p.p., ${dd > 0 ? "kjøp" : "selg"} for ${kr(Math.abs(dd) * PF.plan.start)}` }] }; }),
    row("Forventet avkastning per år", pct(now.ret), pct(sg.perf.ret), "total"),
    row("Svingninger per år", pct(now.vol), pct(sg.perf.vol)),
    row("Et dårlig år (ett av ti er verre)", pc0(res.story.bad), pc0(sg.story?.bad)),
    row("Verste år i historikken", pct(res.story.worst.ret, 0), pct(sg.story?.worst.ret, 0)),
    row({ html: 'Avkastning for risikoen (<a href="#ord-sharpe">Sharpe</a>)' }, `${nf(2).format(now.sharpe)}, ${sharpeWord(now.sharpe)}`, `${nf(2).format(sg.perf.sharpe)}, ${sharpeWord(sg.perf.sharpe)}`),
  ], { caption: "Forslaget i tall" });
}

function renderMap() {
  const res = PF.res, m = res?.model;
  if (!m) { figure("fig-map", { title: "For kort historikk til å vise risiko og avkastning" }); emptyChart("chart-map", "For kort historikk til å vise risiko og avkastning"); return; }
  const sg = res.sg, rfP = m.rf * 100;
  const hx = res.use.map((u, k) => Math.sqrt(m.est.S[k][k]) * 100), hy = Array.from(m.mu, (v) => v * 100);
  const xs = [...hx, m.now.vol * 100], ys = [...hy, m.now.ret * 100];
  const bm = benchSeries(), def = D.summary.defaults;
  const bVol = Math.sqrt(m.est.benchVar) * 100, bRet = ((1 - def.history_weight) * (m.rf + def.market_risk_premium - (D.by[st.bench]?.fee ?? 0) / 100) + def.history_weight * m.est.benchHist) * 100;
  if (bm) { xs.push(bVol); ys.push(bRet); }
  const bg = sharpeLines(xs, ys, rfP);
  const short = (s) => (s.length > 24 ? s.slice(0, 22) + "…" : s);
  const traces = [...bg.traces];
  if (m.frontier) traces.push({ type: "scatter", mode: "lines", name: "Beste blandinger av fondene dine", x: m.frontier.map((p) => p.vol * 100), y: m.frontier.map((p) => p.ret * 100),
    line: { color: css("--chart-reference"), width: 2 }, hoverinfo: "skip" });
  const order = hx.map((x, k) => [x, k]).sort((a, b) => a[0] - b[0]).map((x) => x[1]), pos = [];
  order.forEach((k, i) => { pos[k] = i % 2 ? "bottom center" : "top center"; });
  traces.push({ type: "scatter", mode: "markers+text", name: "Fondene dine", x: hx, y: hy, text: res.use.map((u) => esc(short(u.p.name))), textposition: pos,
    textfont: { family: FONT, size: 12, color: css("--ink-700") }, marker: { size: 11, color: css("--chart-context"), line: { color: css("--line-400"), width: 1 } },
    customdata: res.use.map((u) => u.p.name), hovertemplate: "<b>%{customdata}</b><br>Forventet %{y:.1f}\u00a0% per år · svingninger %{x:.1f}\u00a0%<extra></extra>" });
  if (bm) traces.push({ type: "scatter", mode: "markers+text", name: "Verdensindeksen", x: [bVol], y: [bRet], text: ["Verdensindeksen"], textposition: "middle right", textfont: { family: FONT, size: 12, color: css("--chart-reference") },
    marker: { size: 12, symbol: "diamond-open", color: css("--chart-reference"), line: { width: 2 } }, hovertemplate: `<b>${esc(D.by[st.bench]?.name || "Referanse")}</b><br>Forventet %{y:.1f}\u00a0% · svingninger %{x:.1f}\u00a0%<extra></extra>` });
  traces.push({ type: "scatter", mode: "markers+text", name: "Porteføljen i dag", x: [m.now.vol * 100], y: [m.now.ret * 100], text: ["<b>I dag</b>"], textposition: "middle right",
    textfont: { family: FONT, size: 13, color: css("--ink-900") }, marker: { size: 16, color: css("--chart-focus"), line: { color: css("--bg-000"), width: 2 } },
    hovertemplate: "<b>Porteføljen i dag</b><br>Forventet %{y:.1f}\u00a0% per år · svingninger %{x:.1f}\u00a0%<extra></extra>" });
  const showSg = sg && res.use.some((u, k) => Math.abs(sg.w[k] - u.w) >= 0.015);
  if (showSg) traces.push({ type: "scatter", mode: "markers+text", name: "Forslaget", x: [sg.perf.vol * 100], y: [sg.perf.ret * 100],
    text: ["<b>Forslag</b>"], textposition: "middle left", textfont: { family: FONT, size: 13, color: css("--ink-900") }, marker: { size: 16, color: css("--chart-2"), line: { color: css("--bg-000"), width: 2 } },
    hovertemplate: "<b>Forslaget</b><br>Forventet %{y:.1f}\u00a0% per år · svingninger %{x:.1f}\u00a0%<extra></extra>" });
  figure("fig-map", {
    title: showSg ? `Forslaget gir ${pp(sg.perf.ret - m.now.ret)} forventet avkastning med ${Math.abs(sg.perf.vol - m.now.vol) < 0.004 ? "samme" : sg.perf.vol < m.now.vol ? "lavere" : "høyere"} risiko` : "Porteføljen ligger nær det beste du kan få med disse fondene",
    subtitle: "Forventet avkastning og svingninger per år, etter kostnader, i prosent. Anslag fremover, ikke historikk. Streken viser den beste blandingen av fondene dine for hver risiko.",
    takeaway: SHARPE_HINT, source: "Egne beregninger fra månedsavkastning og Nordnets kostnader",
    about: [["Metode", '<a href="#metode-forslag">Slik er tallene regnet</a>']],
    aria: `Spredningsdiagram: fondene dine, porteføljen i dag${showSg ? " og forslaget" : ""} etter forventet avkastning og svingninger.`,
    data: { name: "risiko-og-avkastning", head: ["", "Svingninger per år (%)", "Forventet avkastning per år (%)"], rows: [
      ...res.use.map((u, k) => [u.p.name, cell(Math.round(hx[k] * 10) / 10, `${nf(1).format(hx[k])}\u00a0%`), cell(Math.round(hy[k] * 10) / 10, `${nf(1).format(hy[k])}\u00a0%`)]),
      ["Porteføljen i dag", cell(Math.round(m.now.vol * 1000) / 10, pct(m.now.vol)), cell(Math.round(m.now.ret * 1000) / 10, pct(m.now.ret))],
      ...(showSg ? [["Forslaget", cell(Math.round(sg.perf.vol * 1000) / 10, pct(sg.perf.vol)), cell(Math.round(sg.perf.ret * 1000) / 10, pct(sg.perf.ret))]] : [])] },
  });
  plot("chart-map", traces, layout({
    showlegend: false, hovermode: "closest", annotations: bg.annotations, margin: { l: 60, r: 16, t: 24, b: 52 },
    xaxis: axis({ ticksuffix: " %", titleText: "Svingninger per år (risiko)", range: bg.xr }),
    yaxis: axis({ ticksuffix: " %", titleText: "Forventet avkastning per år, etter kostnader", range: bg.yr }),
  }));
}

// ---------------------------------------------------------------- summary: one number per question
function renderSummary() {
  const S = PF.res.sum || {};
  const card = (k, label, href, link) => {
    const x = S[k] || { value: "–", text: "" };
    return `<div class="vv-kpi sum-card"><span class="vv-kpi__label">${label}</span><span class="vv-kpi__value">${x.value}</span>
      <span class="sum-text">${x.text}</span><a class="vv-kpi__link vv-link" href="${href}">${link}</a></div>`;
  };
  $("summary").innerHTML = [
    card("own", "Hva eier jeg", "#pf-innhold", "Se hva du eier"),
    card("twin", "Billigere tvilling", "#pf-tvilling", "Se tvillingene"),
    card("cost", "Kostnad", "#pf-kostnad", "Se kostnadene"),
    card("risk", "Risiko", "#pf-risiko", "Se risikoen"),
    card("better", "Bedre fordeling", "#pf-bedre", "Se forslaget"),
  ].join("");
}

// ---------------------------------------------------------------- method
function renderPfMethod() {
  const def = D.summary.defaults, H = PF.H;
  $("pf-method").innerHTML = `
    <h3 id="metode-innhold">Hva eier jeg egentlig?</h3>
    <p>For hvert fond og hver ETF henter vi fordelingen på land, bransjer og aktivaklasser og de 25–35 største beholdningene fra Nordnet (Morningstar-data${H.fetched ? `, hentet ${dateNo(H.fetched)}` : ""}; ${num(H.n || 0)} fond og ETF-er).
      Tallene vektes med andelene dine og legges sammen. Selskapene er bare de største i hvert fond, så andelen i enkeltselskaper er et minimum. Land og bransjer gjelder aksjedelen.</p>
    <h3 id="metode-tvilling">Tvillinger</h3>
    <p>To fond regnes som tvillinger når de har minst ${pc0(TWIN.reg)} felles landfordeling, ${pc0(TWIN.sec)} felles bransjefordeling og de største beholdningene overlapper minst ${pc0(TWIN.top)},
      samme aktivaklasse og samme valutasikring. ETF-er som følger samme indeks (tracking error under ${pct(D.summary.te_threshold, 1)}) er alltid tvillinger. Rentefond sammenlignes på type, valuta og svingninger.
      Ligger fondet ditt på aksjesparekonto, foreslås bare tvillinger som også kan ligge der. «Likt» betyr likt innhold i dag – et aktivt fond kan endre seg.
      «Du sitter igjen med» regner hvert fond for seg: lavere årlig kostnad, minus ${nf(2).format(ETF_FX * 100)} % valutaveksling ved hvert kjøp når tvillingen er en ETF i utenlandsk valuta
      (Nordnets automatiske veksling). Vi regner med at ETF-en spares månedlig med spareavtale, som er uten kurtasje hos Nordnet for et utvalg ETF-er, og at pengene du har i dag flyttes én gang.
      En tvilling som gir mindre etter dette, vises ikke.</p>
    <h3 id="metode-roller">Roller i byggeren</h3>
    <p>Hvert fond og hver ETF får én rolle, ut fra aktivaklasse, region, bransje, tema og stil: ${listNo(ROLE_ORDER.map(roleLc))}.
      Norge og Norden kjennes igjen på navnet eller på at minst 70 % av de største beholdningene er nordiske selskaper. Et globalt fond med minst ${pc0(EM_WORLD)} av aksjene i
      fremvoksende markeder dekker også den rollen («inkl. fremvoksende»). Fond som eier andre fond (fond-i-fond) blir gjennomlyst: de underliggende fondenes største selskaper erstatter fondene i listen.
      Porteføljen har høyst ${MAX_ITEMS} fond og ETF-er. Når du endrer en andel, tar ett fond resten, så summen alltid er 100 %: det første ulåste fondet i rollene likviditet, renter, kombinasjon
      eller global kjerne, ellers det største ulåste fondet. Aksjeandelen er summen av andel × aksjeandelen i hvert fond (fra fondets fordeling på aktivaklasser).</p>
    <h3 id="metode-kjopsplan">Kjøpsplan</h3>
    <p>Neste måneds sparebeløp fordeles på fondene som ligger under målet etter innskuddet, i forhold til hvor mye som mangler. Slik nærmer porteføljen seg målet uten salg.
      Tiden til målet er regnet uten kursendringer, til alle andeler er innenfor 1 prosentpoeng av målet.</p>
    <h3 id="metode-kostnad">Kostnad i kroner</h3>
    <p>Innskudd i starten av hver måned, årlig avkastning før kostnader minus kostnaden, månedlig rentes rente. Eksempel: 1 000 kr i måneden i 20 år med 7 % gir
      ${krRound(I.savingsValue(0, 1000, 20, 0.07, 0.002))} med 0,2 % i kostnad og ${krRound(I.savingsValue(0, 1000, 20, 0.07, 0.015))} med 1,5 %. Står avkastningsfeltet tomt, brukes anslaget for porteføljen din.</p>
    <h3 id="metode-risiko">Risiko</h3>
    <p>Porteføljen regnes måned for måned i kroner med fast fordeling, så langt tilbake som alle delene har historikk. «Verste år» er den dårligste tolvmånedersperioden, «et dårlig år» er nivået ett av ti år har vært verre enn.
      ETF-er bruker egne kurser (og en ETF på samme indeks for årene før de startet). <strong>Fond har vi ikke kurshistorikk for.</strong> Der låner vi månedssvingningene fra den ETF-en som eier mest det samme,
      skalerer dem til fondets egen risiko og forskyver dem så de siste årene gir nøyaktig fondets egen avkastning (Nordnets tall). Norske rentefond anslås fra styringsrenten pluss fondets egen meravkastning og risiko; rentefond som svinger mer enn ${pct(CREDIT.vol)} i året
      (kreditt- og høyrentefond) antas å følge aksjemarkedet et stykke på vei (korrelasjon ${nf(1).format(CREDIT.corr)}), fordi de faller sammen med aksjer i kriser.
      Slike fond er merket «historikk anslått».</p>
    <h3 id="metode-utbytte">Utbytte</h3>
    <p>All avkastning på siden er totalavkastning: utbytte regnes som kjøpt for igjen. For ETF-er legger vi utbyttet fra Yahoo tilbake i kursen. Nordnets avkastning for fond er allerede totalavkastning.
      Yahoo mangler utbytte for noen utdelende ETF-er, og da ser de dårligere ut enn de er. Henger en utdelende ETF mer enn 0,5 prosentpoeng i året etter en akkumulerende andelsklasse på samme indeks
      (justert for kostnad, de siste inntil 5 årene), bygger vi avkastningen på nytt fra den akkumulerende. Er den akkumulerende en annen ETF, må etterslepet være over 1 prosentpoeng og større enn utbyttet som er registrert.
      ${ok(D.quality?.dividends?.n_repaired) ? `Denne måneden gjelder det ${D.quality.dividends.n_repaired} ETF-er, merket «utbytte rettet». ` : ""}Utdelende ETF-er uten registrert utbytte de siste 12 månedene og uten noe å rette fra
      er merket «utbytte mangler i kursene»${ok(D.quality?.dividends?.n_missing) ? ` (${D.quality.dividends.n_missing} denne måneden)` : ""}; avkastningen deres kan være for lav.
      «Utdelende, x % i utbytte» er utbyttet de siste 12 månedene delt på kursen. På aksjesparekonto skattlegges utbytte først ved uttak, men det kommer som kontanter på kontoen og må kjøpes for igjen, ellers blir avkastningen lavere enn tallene på siden.</p>
    <h3 id="metode-anbefalt">Den anbefalte porteføljen</h3>
    <p>Byggeklosser: aksjedelen deles ${pc0(RECO.core)} i et globalt indeksfond, ${pc0(RECO.em)} i fremvoksende markeder og ${pc0(RECO.small)} i små selskaper globalt; resten i et pengemarkedsfond i kroner.
      Hele verden i ett fond: hele aksjedelen i ett globalt indeksfond som også eier fremvoksende markeder (minst ${pc0(EM_WORLD)} av aksjene). Med Norge og Norden går ${pc0(RECO.nordic)} av aksjedelen til et nordisk indeksfond, og det globale fondet får mindre.
      Har du fond fra før, setter «Sett aksjeandelen» aksjeandelen ved å skalere aksjefondene og de andre fondene hver for seg; «Legg til det som mangler» legger til fondene for roller du ikke har.
      Aksjeandelen følger sparetiden (til og med 2 år: 20 %, 5 år: 40 %, 9 år: 60 %, lenger: 80 %) og kan overstyres. Fondene velges på nytt fra dataene hver måned: indeksfond i kroner med minst 1 000 eiere hos Nordnet
      og kostnad innenfor 0,15 prosentpoeng av det billigste; blant dem som ligger innenfor et halvt prosentpoeng av beste femårsavkastning (de følger markedet sitt godt), det billigste.
      Dette er en generell oppskrift, ikke personlig rådgivning – den kjenner ikke gjelden, bufferen eller skatten din.</p>
    <h3 id="metode-vifte">Hva kan sparingen bli verdt?</h3>
    <p>4 000 simulerte forløp med månedlig avkastning trukket fra porteføljens forventede avkastning og svingninger (lognormal, uavhengige måneder). Feltet viser 10.–90. persentil, streken medianen.
      Virkelige markeder har flere ekstreme måneder enn modellen, og tallene er ikke justert for prisvekst.</p>
    <h3 id="metode-forslag">Forventet avkastning og forslaget</h3>
    <p>Forventet avkastning = ${pc0(1 - def.history_weight)} likevekt (risikofri rente ${pct(D.summary.rf_now)} + fondets følsomhet for verdensindeksen × ${pct(def.market_risk_premium)} risikopremie − kostnad)
      + ${pc0(def.history_weight)} historisk snitt de siste ${def.estimation_years} årene. Samvariasjonen mellom fondene er fra samme periode (Ledoit-Wolf-krymping).
      Forslaget er den blandingen av fondene dine som gir høyest forventet avkastning for risikoen du velger. Smale fond (aktive fond, bransje-, tema- og enkeltlandsfond,
      rentefond med høy risiko) får aldri mer enn ${pc0(NARROW_CAP)} hver; brede indeksfond, kombinasjonsfond og trygge rentefond har ingen grense. Sharpe = (avkastning − risikofri rente) / svingninger.
      Dette er anslag med stor usikkerhet – bruk forslaget som et utgangspunkt, ikke en fasit.</p>
    <p><a href="#forbehold">Forbehold</a> og <a href="#begrensninger">kjente begrensninger</a> står lenger ned.</p>`;
}

document.addEventListener("DOMContentLoaded", setupPortfolio);
