// Benchmark metrics. Pure; no DOM.

export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// pairs: [{ predX, predY, actualX, actualY }]
export function errorMetrics(pairs) {
  const errs = [];
  const errX = [];
  const errY = [];
  for (const p of pairs) {
    if (![p.predX, p.predY, p.actualX, p.actualY].every(Number.isFinite)) continue;
    errs.push(Math.hypot(p.predX - p.actualX, p.predY - p.actualY));
    errX.push(Math.abs(p.predX - p.actualX));
    errY.push(Math.abs(p.predY - p.actualY));
  }
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const sorted = [...errs].sort((a, b) => a - b);
  const meanErr = mean(errs);
  const rms = Math.sqrt(mean(errs.map((e) => e * e)));
  return {
    n: errs.length,
    mean: meanErr,
    median: percentile(sorted, 50),
    rms,
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    meanX: mean(errX),
    meanY: mean(errY),
  };
}

export function regionOf(x, y, w, h) {
  const vert = y < h / 3 ? 'top' : y > (2 * h) / 3 ? 'bottom' : 'middle';
  const horiz = x < w / 3 ? 'left' : x > (2 * w) / 3 ? 'right' : 'center';
  return { vert, horiz, label: `${vert}-${horiz}` };
}

// Per-region mean error.
export function regionErrors(pairs, w, h) {
  const buckets = new Map();
  for (const p of pairs) {
    if (![p.predX, p.predY, p.actualX, p.actualY].every(Number.isFinite)) continue;
    const r = regionOf(p.actualX, p.actualY, w, h);
    const key = r.label;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(Math.hypot(p.predX - p.actualX, p.predY - p.actualY));
  }
  const out = {};
  for (const [k, v] of buckets) {
    out[k] = { n: v.length, mean: v.reduce((s, x) => s + x, 0) / v.length };
  }
  return out;
}

// Error stratified by head-pose magnitude, to expose confound sensitivity.
export function errorByHeadPose(rows) {
  const buckets = { low: [], mid: [], high: [] };
  for (const r of rows) {
    if (![r.predX, r.predY, r.actualX, r.actualY].every(Number.isFinite)) continue;
    const hp = r.head
      ? Math.hypot(r.head.yaw ?? 0, r.head.pitch ?? 0) / 0.13
      : 0;
    const e = Math.hypot(r.predX - r.actualX, r.predY - r.actualY);
    if (hp < 0.33) buckets.low.push(e);
    else if (hp < 0.66) buckets.mid.push(e);
    else buckets.high.push(e);
  }
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  return { low: mean(buckets.low), mid: mean(buckets.mid), high: mean(buckets.high) };
}

export function formatPct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

export function formatPx(v) {
  return `${v.toFixed(1)}px`;
}
