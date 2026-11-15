/* ETF-portefølje – plain-language portfolio insight (no DOM). Used by portefolje.js and by node tests.
 *
 *   savingsValue(start, monthly, years, gross, fee)   what a savings plan is worth, after fees
 *   riskStory(r, start, end)                          worst 12 months, deepest fall and time to recover
 *   similarity(a, b)                                  how alike two funds are, from what they own
 *   lookThrough(parts)                                what a whole portfolio owns (regions, sectors, companies)
 *   proxySeries(...)                                  monthly returns for a fund without price history
 *   forRisk(points, vol)                              the frontier portfolio with the wanted risk
 *
 * A holdings record is {reg, sec, ast: {name: percent}, top: [[id, percent], ...]} (see holdings.py).
 */
(function (root) {
  "use strict";

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);

  // ------------------------------------------------------------ cost in kroner
  /** Value after `years`: `start` now plus `monthly` at the start of every month, growing at the
   *  annual net return (gross - fee), compounded monthly. All rates as fractions. */
  function savingsValue(start, monthly, years, gross, fee) {
    const n = Math.round(years * 12);
    const m = Math.pow(Math.max(1e-9, 1 + gross - fee), 1 / 12) - 1;
    const g = Math.pow(1 + m, n);
    return start * g + (Math.abs(m) < 1e-12 ? monthly * n : monthly * (1 + m) * (g - 1) / m);
  }

  // ------------------------------------------------------------ risk as a story
  /** From monthly returns r[start..end]: the worst and best 12 months, a typical bad year, how often a
   *  year ended in minus, and the deepest fall with the month it was recovered (null = not yet). */
  function riskStory(r, start, end) {
    const n = end - start + 1;
    if (n < 13) return null;
    const v = new Float64Array(n + 1);
    v[0] = 1;
    for (let k = 0; k < n; k++) v[k + 1] = v[k] * (1 + r[start + k]);
    const roll = [];
    let worst = { ret: Infinity }, best = { ret: -Infinity };
    for (let k = 12; k <= n; k++) {
      const ret = v[k] / v[k - 12] - 1;
      roll.push(ret);
      if (ret < worst.ret) worst = { ret, from: start + k - 12, to: start + k - 1 };
      if (ret > best.ret) best = { ret, from: start + k - 12, to: start + k - 1 };
    }
    const sorted = roll.slice().sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
    // deepest fall: peak -> trough, then first month back at the peak value
    let peak = 0, dd = { depth: 0, peak: 0, trough: 0 };
    for (let k = 1; k <= n; k++) {
      if (v[k] > v[peak]) peak = k;
      const d = v[k] / v[peak] - 1;
      if (d < dd.depth) dd = { depth: d, peak, trough: k };
    }
    let rec = null;
    for (let k = dd.trough + 1; k <= n; k++) if (v[k] >= v[dd.peak]) { rec = k; break; }
    // v[k] is the value at the end of month start + k - 1
    return {
      values: v, months: n, worst, best, median: q(0.5), bad: q(0.1),
      negShare: roll.filter((x) => x < 0).length / roll.length,
      fall: {
        depth: dd.depth, peak: start + dd.peak - 1, trough: start + dd.trough - 1,
        recovered: rec === null ? null : start + rec - 1,
        monthsDown: dd.trough - dd.peak, monthsBack: rec === null ? null : rec - dd.trough,
        monthsSinceTrough: n - dd.trough,
      },
    };
  }

  // ------------------------------------------------------------ what a fund owns
  function norm(o) {
    let s = 0;
    for (const v of Object.values(o || {})) if (v > 0) s += v;
    if (s <= 0) return null;
    const out = {};
    for (const [k, v] of Object.entries(o)) if (v > 0) out[k] = v / s;
    return out;
  }
  /** Share two allocations have in common (0..1), or null if one is missing. */
  function overlap(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return null;
    let s = 0;
    for (const k of Object.keys(x)) if (y[k]) s += Math.min(x[k], y[k]);
    return s;
  }
  /** Overlap of the largest holdings: common weight relative to the smaller list (0..1), or null. */
  function topOverlap(a, b) {
    if (!a || !b || a.length < 5 || b.length < 5) return null;
    const m = new Map(a);
    let common = 0, sa = 0, sb = 0;
    for (const [, w] of a) sa += w;
    for (const [id, w] of b) { sb += w; if (m.has(id)) common += Math.min(w, m.get(id)); }
    const den = Math.min(sa, sb);
    return den > 0 ? Math.min(1, common / den) : null;
  }
  /** How alike two funds are. `score` 0..1 combines regions, sectors, asset classes and the largest
   *  holdings; null if nothing can be compared. */
  function similarity(a, b) {
    if (!a || !b) return null;
    const reg = overlap(a.reg, b.reg), sec = overlap(a.sec, b.sec), ast = overlap(a.ast, b.ast), top = topOverlap(a.top, b.top);
    const alloc = [reg, sec].filter(isNum);
    if (!alloc.length && !isNum(top)) return isNum(ast) ? { reg, sec, ast, top, score: 0.5 * ast } : null;
    const base = alloc.length ? alloc.reduce((p, q) => p + q, 0) / alloc.length : top;
    let score = isNum(top) ? 0.5 * base + 0.5 * top : base;
    if (isNum(ast)) score *= ast;
    return { reg, sec, ast, top, score };
  }

  /** Whole-portfolio view. `parts` = [{w, h}] with weight (sum 1) and holdings record (or null).
   *  Regions and sectors are shares of the equity part; `companies` are [id, share of portfolio]. */
  function lookThrough(parts) {
    const out = { ast: {}, reg: {}, sec: {}, companies: [], covered: 0, equity: 0, topCovered: 0 };
    const comp = new Map();
    let eq = 0;
    for (const { w, h } of parts) {
      if (!h || !(w > 0)) continue;
      out.covered += w;
      const ast = norm(h.ast) || {};
      for (const [k, v] of Object.entries(ast)) out.ast[k] = (out.ast[k] || 0) + w * v;
      const e = w * (ast.Aksjer ?? (Object.keys(ast).length ? 0 : 1));
      const reg = norm(h.reg), sec = norm(h.sec);
      if (reg && e > 0) { eq += e; for (const [k, v] of Object.entries(reg)) out.reg[k] = (out.reg[k] || 0) + e * v; }
      if (sec && e > 0) for (const [k, v] of Object.entries(sec)) out.sec[k] = (out.sec[k] || 0) + e * v;
      let s = 0;
      for (const [id, pc] of h.top || []) { comp.set(id, (comp.get(id) || 0) + w * pc / 100); s += pc; }
      out.topCovered += w * Math.min(1, s / 100);
    }
    const secSum = Object.values(out.sec).reduce((p, q) => p + q, 0);
    for (const k of Object.keys(out.reg)) out.reg[k] /= eq || 1;
    for (const k of Object.keys(out.sec)) out.sec[k] /= secSum || 1;
    out.equity = eq;
    out.companies = [...comp.entries()].sort((a, b) => b[1] - a[1]);
    return out;
  }

  // ------------------------------------------------------------ funds without price history
  /** Deterministic +-1 sequence (same on every load), used to give synthetic series their volatility. */
  function sign(t) { const x = Math.sin((t + 1) * 12.9898) * 43758.5453; return x - Math.floor(x) < 0.5 ? -1 : 1; }

  /** Monthly returns for a fund that has no price history of its own.
   *  proxy: series of a similar ETF (or null), rf: risk-free series, end: last month index.
   *  o.k       scale of the proxy's excess return (fund volatility / proxy volatility), default 1
   *  o.vol     the fund's own yearly volatility, used when there is no proxy
   *  o.mkt     with no proxy: a market series the fund partly follows, and o.corr its correlation with it
   *            (credit funds fall together with shares in a crisis); o.mktVol = the market's yearly volatility
   *  o.target  [years, annualised return] the fund has actually delivered (Nordnet), or null
   *  o.drag    yearly cost difference fund - proxy (fraction), applied before the target window
   *  Inside the target window the series is shifted so it gives exactly the fund's reported return. */
  function proxySeries(proxy, rf, end, o = {}) {
    const n = rf.length, k = isNum(o.k) ? o.k : 1, out = new Float64Array(n).fill(NaN);
    const corr = !proxy && o.mkt && isNum(o.corr) && isNum(o.mktVol) && o.mktVol > 0 && isNum(o.vol) ? o.corr : 0;
    const beta = corr ? corr * o.vol / o.mktVol : 0;
    const sm = isNum(o.vol) ? o.vol * Math.sqrt(1 - corr * corr) / Math.sqrt(12) : 0;
    const base = (t) => (proxy ? (isNum(proxy[t]) ? rf[t] + k * (proxy[t] - rf[t]) : NaN)
      : rf[t] + sm * sign(t) + (beta && isNum(o.mkt[t]) ? beta * (o.mkt[t] - rf[t]) : 0));
    const drag = (o.drag || 0) / 12;
    let from = end + 1, c = 0;
    if (o.target && isNum(o.target[1])) {
      const len = Math.round(o.target[0] * 12);
      from = end - len + 1;
      let okWin = from >= 0;
      for (let t = from; okWin && t <= end; t++) if (!isNum(base(t))) okWin = false;
      if (okWin) {
        const want = Math.pow(1 + o.target[1], len / 12);
        let lo = -0.05, hi = 0.05;
        for (let it = 0; it < 60; it++) {
          c = (lo + hi) / 2;
          let g = 1;
          for (let t = from; t <= end; t++) g *= 1 + base(t) + c;
          if (g < want) lo = c; else hi = c;
        }
      } else { from = end + 1; c = 0; }
    }
    for (let t = 0; t <= end; t++) {
      const b = base(t);
      if (isNum(b)) out[t] = t >= from ? b + c : b - drag + (proxy ? 0 : c);
    }
    return out;
  }

  // ------------------------------------------------------------ suggestion
  /** From frontier points (sorted by rising risk) the portfolio with volatility `vol`
   *  (weights interpolated between the two neighbours; clamped to the ends). */
  function forRisk(points, vol) {
    const p = points.filter((x) => isNum(x.vol)).sort((a, b) => a.vol - b.vol);
    if (!p.length) return null;
    if (vol <= p[0].vol) return Float64Array.from(p[0].w);
    for (let i = 1; i < p.length; i++) {
      if (vol <= p[i].vol) {
        const a = p[i - 1], b = p[i], f = b.vol > a.vol ? (vol - a.vol) / (b.vol - a.vol) : 1;
        return Float64Array.from(a.w, (w, j) => w + f * (b.w[j] - w));
      }
    }
    return Float64Array.from(p[p.length - 1].w);
  }

  const api = { savingsValue, riskStory, overlap, topOverlap, similarity, lookThrough, proxySeries, forRisk };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Insight = api;
})(typeof window !== "undefined" ? window : globalThis);
