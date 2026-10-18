/* ETF-portefølje – calculation engine (no DOM). Used by app.js in the browser and by node tests.
 *
 * Returns are monthly simple returns in NOK (decimal). A "series" is a Float64Array over the common
 * month grid with NaN where the ETF has no data.
 *
 *   stats(r, b, rf, end, len)     annualised return, volatility, Sharpe, alpha, beta, R², TE, IR, max drawdown
 *   ledoitWolfCC(X)               Ledoit-Wolf shrinkage towards constant correlation (as PyPortfolioOpt)
 *   optimize(mu, S, lo, hi, ...)  max Sharpe / min variance / risk parity / equal weight with box bounds
 *   frontier(mu, S, lo, hi, rf)   efficient frontier under the same bounds
 *   simulate(...)                 monthly backtest with rebalancing rules and trading costs
 */
(function (root) {
  "use strict";

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);

  // ------------------------------------------------------------ data
  function decodeReturns(R) {
    const n = R.n, sc = R.scale, out = {};
    for (const [isin, arr] of Object.entries(R.r)) {
      const s = new Float64Array(n).fill(NaN);
      const off = arr[0];
      for (let k = 1; k < arr.length; k++) s[off + k - 1] = arr[k] / sc;
      out[isin] = s;
    }
    return out;
  }

  function firstIdx(s) { for (let i = 0; i < s.length; i++) if (isNum(s[i])) return i; return -1; }
  function lastIdx(s) { for (let i = s.length - 1; i >= 0; i--) if (isNum(s[i])) return i; return -1; }

  /** Fill months before the start of `s` (and interior gaps) from `donors` (in order). */
  function extend(s, donors) {
    const out = Float64Array.from(s);
    const filled = new Uint8Array(s.length);
    const f0 = firstIdx(s);
    for (const d of donors) {
      for (let i = 0; i < (f0 < 0 ? s.length : f0); i++) {
        if (!isNum(out[i]) && isNum(d[i])) { out[i] = d[i]; filled[i] = 1; }
      }
    }
    // only keep a contiguous filled block that ends right before the own start
    if (f0 > 0) {
      let i = f0 - 1;
      while (i >= 0 && isNum(out[i])) i--;
      for (let k = 0; k <= i; k++) { out[k] = NaN; filled[k] = 0; }
    }
    return { s: out, filled };
  }

  // ------------------------------------------------------------ statistics
  function mean(a) { let s = 0; for (const x of a) s += x; return s / a.length; }

  function annRet(r) { let g = 1; for (const x of r) g *= 1 + x; return Math.pow(g, 12 / r.length) - 1; }

  function maxDrawdown(r) {
    let v = 1, peak = 1, mdd = 0;
    for (const x of r) { v *= 1 + x; if (v > peak) peak = v; const d = v / peak - 1; if (d < mdd) mdd = d; }
    return mdd;
  }

  /** Window statistics for the `len` months ending at index `end` (inclusive). null if r lacks data. */
  function stats(r, b, rf, end, len) {
    const st = end - len + 1;
    if (st < 0) return null;
    const x = new Float64Array(len), y = new Float64Array(len), f = new Float64Array(len);
    let hasB = !!b;
    for (let k = 0; k < len; k++) {
      const v = r[st + k];
      if (!isNum(v)) return null;
      x[k] = v; f[k] = rf[st + k];
      if (hasB) { const w = b[st + k]; if (!isNum(w)) hasB = false; else y[k] = w; }
    }
    const ret = annRet(x), rfa = annRet(f);
    const ex = x.map((v, k) => v - f[k]);
    const mx = mean(ex);
    let vx = 0; for (const v of x) vx += (v - mean(x)) ** 2;
    const vol = Math.sqrt(vx / (len - 1) * 12);
    const out = { ret, vol, sharpe: vol > 0 ? (ret - rfa) / vol : null, mdd: maxDrawdown(x), rf: rfa, n: len };
    if (hasB) {
      const eb = y.map((v, k) => v - f[k]);
      const mb = mean(eb);
      let cxy = 0, vyy = 0, vxx = 0, sd = 0;
      const d = new Float64Array(len);
      for (let k = 0; k < len; k++) {
        cxy += (ex[k] - mx) * (eb[k] - mb); vyy += (eb[k] - mb) ** 2; vxx += (ex[k] - mx) ** 2;
        d[k] = x[k] - y[k];
      }
      const md = mean(d);
      for (const v of d) sd += (v - md) ** 2;
      const beta = vyy > 0 ? cxy / vyy : null;
      const am = beta === null ? null : mx - beta * mb;
      const te = Math.sqrt(sd / (len - 1) * 12);
      const bret = annRet(y);
      out.beta = beta;
      out.alpha = am === null ? null : Math.pow(1 + am, 12) - 1;
      out.r2 = vyy > 0 && vxx > 0 ? (cxy * cxy) / (vxx * vyy) : null;
      out.te = te;
      out.ir = te > 1e-9 ? (ret - bret) / te : null;
      out.excess = ret - bret;
    }
    return out;
  }

  function cumulative(r, start, end, base = 1) {
    const out = [base];
    let v = base;
    for (let i = start; i <= end; i++) { v *= 1 + (isNum(r[i]) ? r[i] : 0); out.push(v); }
    return out;
  }

  function drawdownSeries(values) {
    let peak = -Infinity;
    return values.map((v) => { peak = Math.max(peak, v); return v / peak - 1; });
  }

  // ------------------------------------------------------------ covariance
  /** X: array of T rows (arrays of n returns). Sample covariance (ddof=1). */
  function sampleCov(X) {
    const T = X.length, n = X[0].length, m = new Float64Array(n);
    for (const row of X) for (let j = 0; j < n; j++) m[j] += row[j] / T;
    const S = Array.from({ length: n }, () => new Float64Array(n));
    for (const row of X) for (let a = 0; a < n; a++) { const da = row[a] - m[a]; for (let b = a; b < n; b++) S[a][b] += da * (row[b] - m[b]); }
    for (let a = 0; a < n; a++) for (let b = a; b < n; b++) { S[a][b] /= T - 1; S[b][a] = S[a][b]; }
    return { S, m };
  }

  /** Ledoit & Wolf (2003) shrinkage towards the constant-correlation matrix (port of PyPortfolioOpt).
   *  Returns { S (per period), delta }. */
  function ledoitWolfCC(X) {
    const T = X.length, n = X[0].length;
    const { S, m } = sampleCov(X);
    if (n === 1) return { S, delta: 0 };
    const sd = Array.from({ length: n }, (_, i) => Math.sqrt(S[i][i]));
    let rsum = 0;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) rsum += S[a][b] / (sd[a] * sd[b]);
    const rbar = (rsum - n) / (n * (n - 1));
    const F = Array.from({ length: n }, (_, a) => Float64Array.from({ length: n }, (_, b) => (a === b ? S[a][a] : rbar * sd[a] * sd[b])));
    const Xm = X.map((row) => Float64Array.from(row, (v, j) => v - m[j]));
    // pi
    let piHat = 0;
    const piDiag = new Float64Array(n);
    const help = Array.from({ length: n }, () => new Float64Array(n));
    for (const row of Xm) for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) help[a][b] += row[a] * row[b] / T;
    const y2 = Array.from({ length: n }, () => new Float64Array(n));
    for (const row of Xm) for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) y2[a][b] += row[a] * row[a] * row[b] * row[b] / T;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const p = y2[a][b] - 2 * help[a][b] * S[a][b] + S[a][b] * S[a][b];
      piHat += p;
      if (a === b) piDiag[a] = p;
    }
    // rho
    const t1 = Array.from({ length: n }, () => new Float64Array(n));
    for (const row of Xm) for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) t1[a][b] += row[a] ** 3 * row[b] / T;
    let thetaSum = 0;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const theta = t1[a][b] - help[a][a] * S[a][b] - help[a][b] * S[a][a] + S[a][a] * S[a][b];
      thetaSum += (sd[b] / sd[a]) * theta;
    }
    let rho = 0; for (const p of piDiag) rho += p;
    rho += rbar * thetaSum;
    let gamma = 0;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) gamma += (S[a][b] - F[a][b]) ** 2;
    const kappa = gamma > 0 ? (piHat - rho) / gamma : 0;
    const delta = Math.max(0, Math.min(1, kappa / T));
    const out = S.map((row, a) => row.map((v, b) => delta * F[a][b] + (1 - delta) * v));
    return { S: out, delta };
  }

  // ------------------------------------------------------------ linear algebra helpers
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const matVec = (S, w) => Float64Array.from(S, (row) => dot(row, w));
  const quad = (S, w) => dot(w, matVec(S, w));

  function maxEig(S) {
    const n = S.length;
    let v = new Float64Array(n).fill(1 / Math.sqrt(n)), lam = 0;
    for (let k = 0; k < 200; k++) {
      const u = matVec(S, v);
      const nrm = Math.sqrt(dot(u, u));
      if (nrm === 0) return 0;
      v = u.map((x) => x / nrm);
      if (Math.abs(nrm - lam) < 1e-12 * nrm) { lam = nrm; break; }
      lam = nrm;
    }
    return lam;
  }

  /** Euclidean projection onto { sum w = 1, lo <= w <= hi }. */
  function project(v, lo, hi) {
    const n = v.length;
    const f = (tau) => { let s = 0; for (let i = 0; i < n; i++) s += Math.min(hi[i], Math.max(lo[i], v[i] - tau)); return s - 1; };
    let a = Infinity, b = -Infinity;
    for (let i = 0; i < n; i++) { a = Math.min(a, v[i] - hi[i]); b = Math.max(b, v[i] - lo[i]); }
    for (let k = 0; k < 100; k++) { const m = (a + b) / 2; if (f(m) > 0) a = m; else b = m; }
    const tau = (a + b) / 2;
    return Float64Array.from(v, (x, i) => Math.min(hi[i], Math.max(lo[i], x - tau)));
  }

  function feasible(lo, hi) {
    let sl = 0, sh = 0;
    for (let i = 0; i < lo.length; i++) { if (lo[i] > hi[i] + 1e-12) return false; sl += lo[i]; sh += hi[i]; }
    return sl <= 1 + 1e-9 && sh >= 1 - 1e-9;
  }

  /** min 0.5 w'Sw - t mu'w  s.t. sum w = 1, lo <= w <= hi  (FISTA with projection). */
  function meanVar(mu, S, lo, hi, t, w0, L) {
    const n = mu.length;
    L = L || maxEig(S) || 1;
    let w = project(w0 || new Float64Array(n).fill(1 / n), lo, hi), y = Float64Array.from(w), tk = 1;
    for (let it = 0; it < 20000; it++) {
      const g = matVec(S, y);
      const z = Float64Array.from(y, (v, i) => v - (g[i] - t * mu[i]) / L);
      const wn = project(z, lo, hi);
      const tn = (1 + Math.sqrt(1 + 4 * tk * tk)) / 2;
      let diff = 0;
      for (let i = 0; i < n; i++) { const d = wn[i] - w[i]; diff = Math.max(diff, Math.abs(d)); y[i] = wn[i] + ((tk - 1) / tn) * d; }
      w = wn; tk = tn;
      if (diff < 1e-11 && it > 5) break;
    }
    return w;
  }

  /** Portfolio with the highest expected return under the bounds (greedy). */
  function maxReturn(mu, lo, hi) {
    const n = mu.length, w = Float64Array.from(lo);
    let left = 1 - lo.reduce((s, x) => s + x, 0);
    const order = [...mu.keys()].sort((a, b) => mu[b] - mu[a]);
    for (const i of order) { const add = Math.min(hi[i] - lo[i], left); w[i] += add; left -= add; if (left <= 1e-15) break; }
    return w;
  }

  function perf(w, mu, S, rf) {
    const ret = dot(w, mu), vol = Math.sqrt(Math.max(quad(S, w), 0));
    return { ret, vol, sharpe: vol > 0 ? (ret - rf) / vol : null };
  }

  function frontier(mu, S, lo, hi, rf, points = 40) {
    const L = maxEig(S) || 1;
    const wR = maxReturn(mu, lo, hi);
    const wMin = meanVar(mu, S, lo, hi, 0, null, L);
    // largest t needed: increase until the solution reaches the max-return corner
    let tMax = 1e-3 * L / Math.max(1e-6, Math.max(...mu) - Math.min(...mu));
    let w = wMin;
    for (let k = 0; k < 40; k++) {
      w = meanVar(mu, S, lo, hi, tMax, w, L);
      let d = 0; for (let i = 0; i < w.length; i++) d = Math.max(d, Math.abs(w[i] - wR[i]));
      if (d < 1e-6) break;
      tMax *= 2;
    }
    const pts = [{ t: 0, w: wMin, ...perf(wMin, mu, S, rf) }];
    let prev = wMin;
    for (let k = 1; k <= points; k++) {
      const t = tMax * Math.pow(1e-4, 1 - k / points);
      prev = meanVar(mu, S, lo, hi, t, prev, L);
      pts.push({ t, w: prev, ...perf(prev, mu, S, rf) });
    }
    pts.push({ t: Infinity, w: wR, ...perf(wR, mu, S, rf) });
    return { points: pts, L };
  }

  function maxSharpe(mu, S, lo, hi, rf) {
    const fr = frontier(mu, S, lo, hi, rf, 40);
    const pts = fr.points.filter((p) => isNum(p.sharpe));
    if (!pts.length || Math.max(...mu) <= rf) return { w: fr.points[0].w, note: "Ingen ETF har forventet avkastning over risikofri rente; viser minimum varians." , frontier: fr.points };
    let bi = 0; pts.forEach((p, i) => { if (p.sharpe > pts[bi].sharpe) bi = i; });
    // golden-section refinement on log t between neighbours
    const lt = (p) => Math.log(Math.max(p.t, 1e-12));
    const a0 = pts[Math.max(0, bi - 1)], b0 = pts[Math.min(pts.length - 1, bi + 1)];
    if (!isFinite(a0.t) || !isFinite(b0.t) || a0.t === 0 || b0.t === 0) return { w: pts[bi].w, frontier: fr.points };
    let a = lt(a0), b = lt(b0), best = pts[bi];
    const g = (Math.sqrt(5) - 1) / 2;
    const ev = (x) => { const w = meanVar(mu, S, lo, hi, Math.exp(x), best.w, fr.L); return { w, t: Math.exp(x), ...perf(w, mu, S, rf) }; };
    let c = b - g * (b - a), d = a + g * (b - a), fc = ev(c), fd = ev(d);
    for (let k = 0; k < 30; k++) {
      if (fc.sharpe > fd.sharpe) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = ev(c); }
      else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = ev(d); }
    }
    for (const p of [fc, fd]) if (p.sharpe > best.sharpe) best = p;
    return { w: best.w, frontier: fr.points };
  }

  /** Equal risk contribution (Spinu / cyclical coordinate descent), then projected onto the bounds. */
  function riskParity(S, lo, hi) {
    const n = S.length, b = 1 / n;
    let y = Float64Array.from({ length: n }, (_, i) => 1 / Math.sqrt(S[i][i]));
    for (let it = 0; it < 500; it++) {
      let maxd = 0;
      for (let i = 0; i < n; i++) {
        let a = 0; for (let j = 0; j < n; j++) if (j !== i) a += S[i][j] * y[j];
        const yi = (-a + Math.sqrt(a * a + 4 * S[i][i] * b)) / (2 * S[i][i]);
        maxd = Math.max(maxd, Math.abs(yi - y[i]) / yi); y[i] = yi;
      }
      if (maxd < 1e-10) break;
    }
    const s = y.reduce((p, q) => p + q, 0);
    const w = y.map((v) => v / s);
    const pw = project(w, lo, hi);
    let moved = 0; for (let i = 0; i < n; i++) moved = Math.max(moved, Math.abs(pw[i] - w[i]));
    return { w: pw, adjusted: moved > 1e-6 };
  }

  function riskContrib(w, S) {
    const Sw = matVec(S, w), v = dot(w, Sw);
    return Float64Array.from(w, (x, i) => (v > 0 ? (x * Sw[i]) / v : 0));
  }

  /** Expected returns: (1-h) * (rf + beta * premium) + h * historical mean (annualised arithmetic). */
  function expectedReturns(histMean, beta, rf, premium, h) {
    return Float64Array.from(histMean, (m, i) => (1 - h) * (rf + (isNum(beta[i]) ? beta[i] : 1) * premium) + h * m);
  }

  /** objective: max_sharpe | min_variance | risk_parity | equal | manual */
  function optimize(objective, mu, S, lo, hi, rf, manual) {
    const n = mu.length;
    if (!feasible(lo, hi)) return { error: "Grensene er umulige: summen av minimum må være ≤ 100 % og summen av maksimum ≥ 100 %." };
    let res;
    if (objective === "min_variance") res = { w: meanVar(mu, S, lo, hi, 0) };
    else if (objective === "risk_parity") { const r = riskParity(S, lo, hi); res = { w: r.w, note: r.adjusted ? "Risikoparitet er justert for å holde min./maks.-grensene, så risikobidragene er ikke helt like." : null }; }
    else if (objective === "equal") { const w = project(new Float64Array(n).fill(1 / n), lo, hi); res = { w }; }
    else if (objective === "manual") {
      const s = manual.reduce((p, q) => p + (q > 0 ? q : 0), 0);
      res = { w: Float64Array.from(manual, (x) => (s > 0 ? Math.max(x, 0) / s : 1 / n)), note: s > 0 && Math.abs(s - 1) > 1e-6 ? "Manuelle vekter er skalert til 100 %." : null };
    } else res = maxSharpe(mu, S, lo, hi, rf);
    res.w = Float64Array.from(res.w, (x) => (Math.abs(x) < 1e-7 ? 0 : x));
    return res;
  }

  // ------------------------------------------------------------ backtest
  /** Monthly simulation.
   *  rets: array (assets) of Float64Array over the month grid; months [start..end] simulated.
   *  targetAt(i) -> Float64Array target weights decided at the end of month i-1 (called at start and
   *  at each reoptimisation month), reoptAt(i) -> bool. rule: monthly|quarterly|annual|band|none.
   *  cost: fraction of traded value. Returns { values (len+1), weights history, turnover, costs }. */
  function simulate(rets, start, end, targetAt, reoptAt, rule, band, cost, monthIdxToCal) {
    const n = rets.length;
    let target = targetAt(start);
    let w = Float64Array.from(target), value = 1;
    const values = [1], held = [Float64Array.from(w)];
    let turnover = 0, costs = 0, trades = 0;
    for (let i = start; i <= end; i++) {
      // returns during month i
      let g = 0; const v = new Float64Array(n);
      for (let a = 0; a < n; a++) { const r = isNum(rets[a][i]) ? rets[a][i] : 0; v[a] = w[a] * (1 + r); g += v[a]; }
      value *= g;
      w = v.map((x) => x / g);
      // decisions at the end of month i
      if (i < end) {
        let newTarget = false;
        if (reoptAt(i + 1)) { const t = targetAt(i + 1); if (t) { target = t; newTarget = true; } }
        const cal = monthIdxToCal(i);     // {y, m: 1..12}
        let reb = newTarget;
        if (rule === "monthly") reb = true;
        else if (rule === "quarterly") reb = reb || cal.m % 3 === 0;
        else if (rule === "annual") reb = reb || cal.m === 12;
        else if (rule === "band") { for (let a = 0; a < n; a++) if (Math.abs(w[a] - target[a]) > band) reb = true; }
        else if (rule === "none") reb = newTarget;
        if (reb) {
          let tr = 0; for (let a = 0; a < n; a++) tr += Math.abs(target[a] - w[a]);
          if (tr > 1e-9) { trades++; turnover += tr / 2; const c = cost * tr; costs += c; value *= 1 - c; }
          w = Float64Array.from(target);
        }
      }
      values.push(value);
      held.push(Float64Array.from(w));
    }
    const years = (end - start + 1) / 12;
    return { values, held, turnoverPerYear: turnover / years, costsPerYear: costs / years, tradesPerYear: trades / years };
  }

  /** Monthly returns from a value path. */
  function pathReturns(values) { const r = new Float64Array(values.length - 1); for (let i = 1; i < values.length; i++) r[i - 1] = values[i] / values[i - 1] - 1; return r; }

  const api = { isNum, decodeReturns, firstIdx, lastIdx, extend, stats, annRet, maxDrawdown, cumulative, drawdownSeries,
    sampleCov, ledoitWolfCC, project, feasible, meanVar, maxReturn, perf, frontier, maxSharpe, riskParity, riskContrib,
    expectedReturns, optimize, simulate, pathReturns, dot, matVec, quad };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
