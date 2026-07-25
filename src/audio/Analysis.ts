import type { AudioEngine } from './AudioEngine';

export const NUM_BANDS = 128;

const MIN_HZ = 28;
const MAX_HZ = 16500;

/** Everything the visuals are allowed to know about the sound. */
export interface Features {
  /** Log-spaced spectrum, 0..1, auto-levelled. */
  bands: Float32Array;
  /** Slow peak-hold of `bands` — good for silhouettes and terrain. */
  peaks: Float32Array;
  /** Raw time-domain samples, -1..1. */
  wave: Float32Array;
  /** 12 pitch-class energies, normalised so the strongest is 1. */
  chroma: Float32Array;

  level: number;
  sub: number;
  bass: number;
  lowMid: number;
  mid: number;
  high: number;
  air: number;

  /** Spectral centroid mapped to 0..1 — "how bright does this sound". */
  brightness: number;
  /** Rectified spectral flux, 0..1. */
  flux: number;
  /** True only on the frame an onset is detected. */
  onset: boolean;
  /** Exponentially decaying kick from the last onset, 0..1. */
  beat: number;
  /** Phase-locked position inside the current beat, 0..1. */
  beatPhase: number;
  /** Phase-locked position inside the current bar (4 beats), 0..1. */
  barPhase: number;
  /** Ticks up once per detected beat. */
  beatCount: number;
  bpm: number;
  /** How much we trust `bpm`, 0..1. */
  tempoConfidence: number;
  /** Positive when the track is building, negative when it drops out. */
  drift: number;
  /** 1 when nothing is playing. */
  silence: number;
  /** Circular hue suggestion derived from harmonic content, 0..1. */
  hue: number;
  /** Seconds since the analyser started. */
  time: number;
  /** Smoothed estimate of the dominant partial, in Hz. */
  dominantHz: number;
  /** Samples per second of `wave`. */
  sampleRate: number;
}

interface BandRange {
  lo: number;
  hi: number;
  center: number;
}

/** Frame-rate independent one-pole smoothing. */
const glide = (current: number, target: number, tau: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));

export class Analysis {
  readonly features: Features;

  private readonly engine: AudioEngine;
  private readonly ranges: BandRange[] = [];
  private readonly mag: Float32Array;
  private readonly prevMag: Float32Array;
  private readonly binPitchClass: Int16Array;
  private readonly bandTilt: Float32Array;
  private readonly chromaRaw = new Float32Array(12);

  private readonly fluxHistory = new Float32Array(64);
  private readonly fluxScratch = new Float32Array(64);
  private fluxIndex = 0;

  /** Folded inter-onset-interval histogram, 60..185 BPM. */
  private readonly tempoBins = new Float32Array(72);
  private readonly onsetTimes: number[] = [];

  private loudRef = -40;
  private beatPeriod = 0.5;
  private phase = 0;
  private beats = 0;
  private lastOnset = -1;
  private levelSlow = 0;
  private levelFast = 0;
  private hueVec = { x: 1, y: 0 };
  private clock = 0;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    const bins = engine.analyser.frequencyBinCount;
    const binHz = engine.sampleRate / (bins * 2);

    this.mag = new Float32Array(bins);
    this.prevMag = new Float32Array(bins);

    // Log-spaced band edges; every band claims at least one bin.
    let cursor = 1;
    for (let i = 0; i < NUM_BANDS; i++) {
      const f0 = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / NUM_BANDS);
      const f1 = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, (i + 1) / NUM_BANDS);
      const lo = Math.max(cursor, Math.floor(f0 / binHz));
      const hi = Math.max(lo + 1, Math.min(bins - 1, Math.ceil(f1 / binHz)));
      cursor = Math.min(hi, bins - 2);
      this.ranges.push({ lo, hi, center: Math.sqrt(f0 * f1) });
    }

    // Pink-ish tilt: real music loses ~4.5 dB per octave, so lift the top end
    // to keep the upper bands visually alive without turning noise into snow.
    this.bandTilt = new Float32Array(NUM_BANDS);
    for (let i = 0; i < NUM_BANDS; i++) {
      const octaves = Math.log2(this.ranges[i].center / 180);
      this.bandTilt[i] = Math.max(-3, Math.min(20, octaves * 4.2));
    }

    this.binPitchClass = new Int16Array(bins).fill(-1);
    for (let i = 1; i < bins; i++) {
      const f = i * binHz;
      if (f < 60 || f > 3000) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      this.binPitchClass[i] = ((Math.round(midi) % 12) + 12) % 12;
    }

    this.features = {
      bands: new Float32Array(NUM_BANDS),
      peaks: new Float32Array(NUM_BANDS),
      wave: engine.wave,
      chroma: new Float32Array(12),
      level: 0,
      sub: 0,
      bass: 0,
      lowMid: 0,
      mid: 0,
      high: 0,
      air: 0,
      brightness: 0.5,
      flux: 0,
      onset: false,
      beat: 0,
      beatPhase: 0,
      barPhase: 0,
      beatCount: 0,
      bpm: 120,
      tempoConfidence: 0,
      drift: 0,
      silence: 1,
      hue: 0,
      time: 0,
      dominantHz: 220,
      sampleRate: engine.sampleRate,
    };
  }

  update(dt: number): Features {
    const f = this.features;
    this.clock += dt;
    f.time = this.clock;

    this.engine.sample();
    const db = this.engine.freq;
    const wave = this.engine.wave;
    const bins = this.mag.length;

    // ---- level + automatic gain reference -------------------------------
    let sumSq = 0;
    for (let i = 0; i < wave.length; i++) sumSq += wave[i] * wave[i];
    const rms = Math.sqrt(sumSq / wave.length);
    const rmsDb = 20 * Math.log10(rms + 1e-7);

    if (rmsDb > this.loudRef) this.loudRef += (rmsDb - this.loudRef) * 0.3;
    else this.loudRef -= dt * 1.6;
    this.loudRef = Math.max(-52, Math.min(0, this.loudRef));
    // Aim the loudest recent moment at roughly -11 dBFS.
    const gainDb = Math.max(-6, Math.min(34, -11 - this.loudRef));

    this.levelFast = glide(this.levelFast, Math.min(1, rms * Math.pow(10, gainDb / 20) * 3.2), 0.03, dt);
    this.levelSlow = glide(this.levelSlow, this.levelFast, 0.9, dt);
    f.level = this.levelFast;
    f.drift = Math.max(-1, Math.min(1, (this.levelFast - this.levelSlow) * 3));
    f.silence = glide(f.silence, rmsDb < -58 ? 1 : 0, 0.5, dt);

    // ---- linear magnitudes + flux ---------------------------------------
    let flux = 0;
    let centroidNum = 0;
    let centroidDen = 0;
    this.chromaRaw.fill(0);
    for (let i = 1; i < bins; i++) {
      const m = Math.pow(10, db[i] / 20);
      this.mag[i] = m;
      const d = m - this.prevMag[i];
      if (d > 0) flux += d;
      this.prevMag[i] = m;

      const pc = this.binPitchClass[i];
      if (pc >= 0) this.chromaRaw[pc] += m;

      centroidNum += m * i;
      centroidDen += m;
    }
    flux = (flux / bins) * Math.pow(10, gainDb / 20) * 240;
    f.flux = glide(f.flux, Math.min(1, flux), 0.05, dt);

    const centroidBin = centroidDen > 1e-9 ? centroidNum / centroidDen : 1;
    const centroidHz = (centroidBin * this.engine.sampleRate) / (bins * 2);
    f.brightness = glide(
      f.brightness,
      Math.max(0, Math.min(1, (Math.log2(centroidHz + 20) - Math.log2(120)) / Math.log2(9000 / 120))),
      0.12,
      dt,
    );

    // ---- bands -----------------------------------------------------------
    for (let i = 0; i < NUM_BANDS; i++) {
      const { lo, hi } = this.ranges[i];
      let energy = 0;
      for (let b = lo; b < hi; b++) energy += this.mag[b] * this.mag[b];
      const amp = Math.sqrt(energy / (hi - lo));
      const value = 20 * Math.log10(amp + 1e-9) + gainDb + this.bandTilt[i];
      const norm = Math.max(0, Math.min(1, (value + 64) / 50));
      // Fast attack, lazy release: reads as "punchy" rather than "twitchy".
      f.bands[i] = glide(f.bands[i], norm, norm > f.bands[i] ? 0.012 : 0.11, dt);
      f.peaks[i] = Math.max(f.bands[i], f.peaks[i] - dt * 0.42);
    }

    // Loudest band between 55 Hz and 1.2 kHz — good enough to lock an
    // oscilloscope's phase offset onto the note that is actually sounding.
    let domIdx = -1;
    let domVal = 0.12;
    for (let i = 0; i < NUM_BANDS; i++) {
      const c = this.ranges[i].center;
      if (c < 55 || c > 1200) continue;
      if (f.bands[i] > domVal) {
        domVal = f.bands[i];
        domIdx = i;
      }
    }
    if (domIdx >= 0) f.dominantHz = glide(f.dominantHz, this.ranges[domIdx].center, 0.25, dt);

    f.sub = this.macro(f.sub, 28, 68, dt);
    f.bass = this.macro(f.bass, 60, 180, dt);
    f.lowMid = this.macro(f.lowMid, 180, 520, dt);
    f.mid = this.macro(f.mid, 520, 2100, dt);
    f.high = this.macro(f.high, 2100, 6500, dt);
    f.air = this.macro(f.air, 6500, 16000, dt);

    // ---- chroma + hue ----------------------------------------------------
    let cmax = 1e-9;
    for (let i = 0; i < 12; i++) cmax = Math.max(cmax, this.chromaRaw[i]);
    let hx = 0;
    let hy = 0;
    for (let i = 0; i < 12; i++) {
      const v = this.chromaRaw[i] / cmax;
      f.chroma[i] = glide(f.chroma[i], v, 0.18, dt);
      // Walk the circle of fifths so neighbouring keys get neighbouring hues.
      const a = (((i * 7) % 12) / 12) * Math.PI * 2;
      const w = Math.pow(f.chroma[i], 3);
      hx += Math.cos(a) * w;
      hy += Math.sin(a) * w;
    }
    const hlen = Math.hypot(hx, hy);
    if (hlen > 1e-5) {
      const k = 1 - Math.exp(-dt / 1.4);
      this.hueVec.x += (hx / hlen - this.hueVec.x) * k;
      this.hueVec.y += (hy / hlen - this.hueVec.y) * k;
    }
    f.hue = (Math.atan2(this.hueVec.y, this.hueVec.x) / (Math.PI * 2) + 1) % 1;

    // ---- onsets ----------------------------------------------------------
    this.fluxHistory[this.fluxIndex] = flux;
    this.fluxIndex = (this.fluxIndex + 1) % this.fluxHistory.length;
    this.fluxScratch.set(this.fluxHistory);
    this.fluxScratch.sort();
    const median = this.fluxScratch[this.fluxHistory.length >> 1];
    const threshold = median * 1.55 + 0.012;

    const now = this.clock;
    const onset = flux > threshold && now - this.lastOnset > 0.11 && f.silence < 0.6;
    f.onset = onset;
    if (onset) {
      this.registerOnset(now);
      this.lastOnset = now;
      f.beat = 1;
    } else {
      f.beat = Math.max(0, f.beat - dt / 0.22);
    }

    // ---- tempo + beat clock ---------------------------------------------
    this.trackTempo(dt, onset);
    f.bpm = 60 / this.beatPeriod;
    f.beatPhase = this.phase;
    f.barPhase = ((this.beats % 4) + this.phase) / 4;
    f.beatCount = this.beats;

    if (f.silence > 0.01) this.idleWash(f, dt);

    return f;
  }

  /**
   * With no signal every scene would sit frozen in the dark, which reads as
   * broken rather than idle. Fade in a slow synthetic swell instead — it only
   * ever raises values, never masks real audio, and the readouts still say "—".
   */
  private idleWash(f: Features, dt: number): void {
    const k = f.silence;
    const t = this.clock;
    for (let i = 0; i < NUM_BANDS; i++) {
      const x = i / NUM_BANDS;
      const wash =
        0.17 * Math.exp(-x * 2.4) * (0.55 + 0.45 * Math.sin(t * 0.55 + x * 8.0)) +
        0.035 * (0.5 + 0.5 * Math.sin(t * 0.31 - x * 14.0));
      f.bands[i] = Math.max(f.bands[i], wash * k);
      f.peaks[i] = Math.max(f.peaks[i], f.bands[i]);
    }
    f.level = Math.max(f.level, 0.1 * k * (0.6 + 0.4 * Math.sin(t * 0.5)));
    f.bass = Math.max(f.bass, 0.13 * k * (0.5 + 0.5 * Math.sin(t * 0.42)));
    f.lowMid = Math.max(f.lowMid, 0.09 * k);
    f.mid = Math.max(f.mid, 0.07 * k * (0.5 + 0.5 * Math.sin(t * 0.27 + 2)));
    f.high = Math.max(f.high, 0.05 * k);
    f.hue = (f.hue + dt * 0.018 * k) % 1;
  }

  /** Average the (already normalised) bands that fall inside a frequency window. */
  private macro(prev: number, loHz: number, hiHz: number, dt: number): number {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < NUM_BANDS; i++) {
      const c = this.ranges[i].center;
      if (c >= loHz && c < hiHz) {
        sum += this.features.bands[i];
        n++;
      }
    }
    const target = n ? sum / n : 0;
    return glide(prev, target, target > prev ? 0.02 : 0.13, dt);
  }

  private registerOnset(now: number): void {
    this.onsetTimes.push(now);
    if (this.onsetTimes.length > 12) this.onsetTimes.shift();
    const n = this.onsetTimes.length;
    // Compare against the last few onsets so we catch the beat even when the
    // detector fires on off-beat percussion.
    for (let back = 1; back <= 4 && n - 1 - back >= 0; back++) {
      let interval = now - this.onsetTimes[n - 1 - back];
      if (interval < 0.15 || interval > 4) continue;
      // Fold into 0.325..0.97 s (≈62–185 BPM).
      while (interval < 0.325) interval *= 2;
      while (interval > 0.97) interval /= 2;
      const bpm = 60 / interval;
      const slot = ((bpm - 60) / 125) * this.tempoBins.length;
      const weight = 1 / back;
      for (let k = -2; k <= 2; k++) {
        const idx = Math.round(slot) + k;
        if (idx < 0 || idx >= this.tempoBins.length) continue;
        this.tempoBins[idx] += weight * Math.exp(-(k * k) / 2);
      }
    }
  }

  private trackTempo(dt: number, onset: boolean): void {
    let peak = 0;
    let peakIdx = -1;
    let total = 0;
    for (let i = 0; i < this.tempoBins.length; i++) {
      this.tempoBins[i] *= Math.exp(-dt / 9);
      total += this.tempoBins[i];
      if (this.tempoBins[i] > peak) {
        peak = this.tempoBins[i];
        peakIdx = i;
      }
    }
    const confidence = total > 0.5 ? Math.min(1, (peak / total) * 6) : 0;
    this.features.tempoConfidence = glide(this.features.tempoConfidence, confidence, 0.6, dt);

    if (peakIdx >= 0 && confidence > 0.15) {
      const bpm = 60 + (peakIdx / this.tempoBins.length) * 125;
      const target = 60 / bpm;
      this.beatPeriod += (target - this.beatPeriod) * Math.min(1, dt * 0.9 * confidence);
    }
    this.beatPeriod = Math.max(0.3, Math.min(1.05, this.beatPeriod));

    this.phase += dt / this.beatPeriod;
    while (this.phase >= 1) {
      this.phase -= 1;
      this.beats++;
    }

    // Phase-locked loop: nudge the clock towards each onset rather than
    // snapping, so the choreography stays smooth through missed beats.
    if (onset) {
      const err = this.phase > 0.5 ? this.phase - 1 : this.phase;
      if (Math.abs(err) < 0.35) {
        this.phase -= err * 0.22;
        this.beatPeriod *= 1 + err * 0.012;
        if (this.phase < 0) {
          this.phase += 1;
          this.beats--;
        }
      }
    }
  }
}
