// Heart rate from the face camera ("remote PPG").
// Each heartbeat changes skin colour very slightly. We average the colour of the
// forehead and cheeks every frame, then use the POS method (Wang et al., 2017)
// to pull out the pulse signal and find its strongest frequency.

const FS = 30; // resample everything to 30 samples per second

export class RPPG {
  constructor(maxSec = 40) {
    this.maxSec = maxSec;
    this.t = [];
    this.rgb = [];
  }

  reset() { this.t = []; this.rgb = []; }

  push(tMs, r, g, b) {
    this.t.push(tMs);
    this.rgb.push([r, g, b]);
    const cutoff = tMs - this.maxSec * 1000;
    while (this.t.length && this.t[0] < cutoff) { this.t.shift(); this.rgb.shift(); }
  }

  // Estimate heart rate over the `winSec` seconds ending at `endMs`.
  // Returns { bpm, snrDb, quality (0..1), rmssd (ms or null) } or null if not enough data.
  estimate(endMs, winSec = 10) {
    const startMs = endMs - winSec * 1000;
    const idx = [];
    for (let i = 0; i < this.t.length; i++) if (this.t[i] >= startMs && this.t[i] <= endMs) idx.push(i);
    if (idx.length < winSec * 10) return null; // need at least ~10 fps
    const t0 = this.t[idx[0]], t1 = this.t[idx[idx.length - 1]];
    if (t1 - t0 < winSec * 800) return null;

    // Resample to a uniform 30 Hz grid
    const n = Math.floor(((t1 - t0) / 1000) * FS);
    const R = new Float64Array(n), G = new Float64Array(n), B = new Float64Array(n);
    let j = 0;
    for (let k = 0; k < n; k++) {
      const tk = t0 + (k * 1000) / FS;
      while (j < idx.length - 2 && this.t[idx[j + 1]] < tk) j++;
      const a = idx[j], b = idx[j + 1];
      const span = this.t[b] - this.t[a] || 1;
      const f = Math.min(1, Math.max(0, (tk - this.t[a]) / span));
      R[k] = this.rgb[a][0] + f * (this.rgb[b][0] - this.rgb[a][0]);
      G[k] = this.rgb[a][1] + f * (this.rgb[b][1] - this.rgb[a][1]);
      B[k] = this.rgb[a][2] + f * (this.rgb[b][2] - this.rgb[a][2]);
    }

    const pulse = detrend(pos(R, G, B, FS), FS);
    const spec = spectrum(pulse, FS, 42, 180, 0.5);
    let best = 0;
    for (let i = 1; i < spec.p.length; i++) if (spec.p[i] > spec.p[best]) best = i;
    const bpm = spec.f[best];

    // Signal-to-noise: power near the peak (and its first harmonic) vs everything else
    let sig = 0, tot = 0;
    for (let i = 0; i < spec.p.length; i++) {
      tot += spec.p[i];
      if (Math.abs(spec.f[i] - bpm) <= 5 || Math.abs(spec.f[i] - 2 * bpm) <= 5) sig += spec.p[i];
    }
    const snrDb = 10 * Math.log10(sig / Math.max(tot - sig, 1e-12));
    const quality = clamp((snrDb + 6) / 10, 0, 1);

    return { bpm, snrDb, quality, rmssd: rmssd(pulse, FS, bpm) };
  }
}

function pos(R, G, B, fs) {
  const n = R.length, l = Math.round(1.6 * fs);
  const H = new Float64Array(n);
  if (n < l) return H;
  const s1 = new Float64Array(l), s2 = new Float64Array(l);
  for (let start = 0; start <= n - l; start++) {
    let mr = 0, mg = 0, mb = 0;
    for (let i = 0; i < l; i++) { mr += R[start + i]; mg += G[start + i]; mb += B[start + i]; }
    mr /= l; mg /= l; mb /= l;
    if (!mr || !mg || !mb) continue;
    for (let i = 0; i < l; i++) {
      const r = R[start + i] / mr, g = G[start + i] / mg, b = B[start + i] / mb;
      s1[i] = g - b;
      s2[i] = g + b - 2 * r;
    }
    const alpha = std(s1) / (std(s2) || 1e-9);
    let mh = 0;
    const h = new Float64Array(l);
    for (let i = 0; i < l; i++) { h[i] = s1[i] + alpha * s2[i]; mh += h[i]; }
    mh /= l;
    for (let i = 0; i < l; i++) H[start + i] += h[i] - mh;
  }
  return H;
}

// Remove slow drift (1 s moving average) and smooth a little (3-sample average)
function detrend(x, fs) {
  const w = Math.round(fs), n = x.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { s += x[k]; c++; }
    out[i] = x[i] - s / c;
  }
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) sm[i] = (out[Math.max(0, i - 1)] + out[i] + out[Math.min(n - 1, i + 1)]) / 3;
  return sm;
}

function spectrum(x, fs, minBpm, maxBpm, step) {
  const f = [], p = [];
  for (let bpm = minBpm; bpm <= maxBpm; bpm += step) {
    const w = (2 * Math.PI * bpm) / 60 / fs;
    let re = 0, im = 0;
    for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos(w * i); im += x[i] * Math.sin(w * i); }
    f.push(bpm); p.push(re * re + im * im);
  }
  return { f, p };
}

// Heart rate variability (RMSSD) from beat-to-beat intervals. Noisy at 30 fps.
function rmssd(raw, fs, bpm) {
  // Extra smoothing (about 1/5 of a beat) so noise doesn't create fake beats
  const w = Math.max(1, Math.round((fs * 60) / bpm / 10));
  const x = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(raw.length - 1, i + w); k++) { s += raw[k]; c++; }
    x[i] = s / c;
  }
  const minDist = Math.floor(0.6 * (60 / bpm) * fs);
  const peaks = [];
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] > x[i - 1] && x[i] >= x[i + 1] && x[i] > 0) {
      const last = peaks[peaks.length - 1];
      if (last !== undefined && i - last < minDist) { if (x[i] > x[last]) peaks[peaks.length - 1] = i; }
      else peaks.push(i);
    }
  }
  // Sub-sample peak position by parabolic interpolation
  const times = peaks.map((i) => {
    const a = x[i - 1], b = x[i], c = x[i + 1];
    const d = a - 2 * b + c;
    return ((i + (d ? (0.5 * (a - c)) / d : 0)) / fs) * 1000;
  });
  const ibi = [];
  for (let i = 1; i < times.length; i++) ibi.push(times[i] - times[i - 1]);
  if (ibi.length < 5) return null;
  const med = [...ibi].sort((a, b) => a - b)[Math.floor(ibi.length / 2)];
  const good = ibi.filter((v) => Math.abs(v - med) < 0.3 * med);
  if (good.length < 5) return null;
  let s = 0;
  for (let i = 1; i < good.length; i++) s += (good[i] - good[i - 1]) ** 2;
  return Math.sqrt(s / (good.length - 1));
}

function std(a) {
  let m = 0;
  for (const v of a) m += v;
  m /= a.length;
  let s = 0;
  for (const v of a) s += (v - m) ** 2;
  return Math.sqrt(s / a.length);
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
