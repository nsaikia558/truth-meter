// Microphone: loudness, when speech starts, and voice pitch. Nothing is recorded or uploaded.

export class Voice {
  constructor() {
    this.samples = [];
    this.level = 0;
    this.threshold = 0.012;
    this.ready = false;
  }

  async start(stream) {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(stream);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 2048;
    src.connect(this.an);
    this.buf = new Float32Array(this.an.fftSize);
    this.tickN = 0;
    this.timer = setInterval(() => this.tick(), 30);
    this.ready = true;
  }

  stop() {
    clearInterval(this.timer);
    this.ctx?.close();
    this.ready = false;
  }

  tick() {
    this.an.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (const v of this.buf) s += v * v;
    const rms = Math.sqrt(s / this.buf.length);
    this.level = rms;
    const t = performance.now();
    let pitch = null;
    if (rms > this.threshold && (this.tickN++ % 2 === 0)) pitch = estimatePitch(this.buf, this.ctx.sampleRate);
    this.samples.push({ t, rms, pitch });
    while (this.samples.length && this.samples[0].t < t - 90000) this.samples.shift();
  }

  // Measure room noise for `ms` milliseconds (person stays quiet), then set the speech threshold.
  async calibrateNoise(ms = 1500) {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    const vals = this.samples.filter((x) => x.t >= t0).map((x) => x.rms).sort((a, b) => a - b);
    const noise = vals.length ? vals[Math.floor(vals.length / 2)] : 0.004;
    this.threshold = Math.max(noise * 3.5, 0.008);
    return { noise, threshold: this.threshold };
  }

  // Summary of speech between t0 and t1 (ms, performance.now clock)
  window(t0, t1) {
    const fr = this.samples.filter((x) => x.t >= t0 && x.t <= t1);
    let onset = null, run = 0, speech = 0;
    for (const x of fr) {
      if (x.rms > this.threshold) {
        run++; speech++;
        if (run === 3 && onset === null) onset = (x.t - t0) / 1000 - 0.06;
      } else run = 0;
    }
    const p = fr.map((x) => x.pitch).filter((v) => v);
    const mean = p.length ? p.reduce((a, b) => a + b, 0) / p.length : null;
    return {
      onset,
      speechSec: speech * 0.03,
      pitchMean: p.length >= 3 ? mean : null,
    };
  }
}

// Autocorrelation pitch estimate on a 2x-downsampled frame, 75-400 Hz
function estimatePitch(buf, sr) {
  const n = buf.length >> 1;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (buf[2 * i] + buf[2 * i + 1]) / 2;
  const fs = sr / 2;
  const minLag = Math.floor(fs / 400), maxLag = Math.floor(fs / 75);
  let e = 0;
  for (let i = 0; i < n; i++) e += x[i] * x[i];
  if (!e) return null;
  let bestLag = -1, best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = 0; i < n - lag; i++) c += x[i] * x[i + lag];
    c /= e;
    if (c > best) { best = c; bestLag = lag; }
  }
  return best > 0.45 ? fs / bestLag : null;
}
