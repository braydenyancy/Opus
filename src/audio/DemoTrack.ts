/**
 * "Parallax" — a generative track, synthesised entirely in WebAudio.
 *
 * There are no audio assets in this project. Everything you hear is built from
 * oscillators and noise at runtime, sequenced by a lookahead scheduler and
 * arranged into an eight-section form that keeps re-voicing itself, so the
 * visualiser always has real music to chew on out of the box.
 */

const BPM = 122;
const SPB = 60 / BPM; // seconds per beat
const STEP = SPB / 4; // sixteenth note
const LOOKAHEAD = 0.14; // seconds of events scheduled ahead of the clock
const TICK = 25; // scheduler interval, ms

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** i – VI – III – VII in A minor, two bars each. */
interface Chord {
  bass: number;
  tones: number[];
  pad: number[];
}
const PROGRESSION: Chord[] = [
  { bass: 45, tones: [57, 60, 64, 67], pad: [57, 64, 67, 72] }, // Am7
  { bass: 41, tones: [53, 57, 60, 64], pad: [57, 60, 65, 69] }, // Fmaj7
  { bass: 48, tones: [55, 60, 64, 67], pad: [55, 64, 67, 71] }, // Cmaj7
  { bass: 43, tones: [55, 59, 62, 67], pad: [59, 62, 67, 74] }, // G
];

const PENTATONIC = [57, 60, 62, 64, 67, 69, 72, 74, 76];

interface Section {
  drums: 0 | 1 | 2; // 0 none · 1 sparse · 2 full
  bass: boolean;
  arp: boolean;
  pad: number; // pad level
  lead: boolean;
  riser: boolean;
  cut: number; // global filter openness 0..1
}

/** Eight sections of eight bars. Section 0 only plays once, then it loops 1..7. */
const FORM: Section[] = [
  { drums: 0, bass: false, arp: true, pad: 0.5, lead: false, riser: false, cut: 0.45 },
  { drums: 1, bass: false, arp: true, pad: 0.6, lead: false, riser: false, cut: 0.6 },
  { drums: 2, bass: true, arp: true, pad: 0.7, lead: false, riser: false, cut: 0.8 },
  { drums: 2, bass: true, arp: true, pad: 0.7, lead: true, riser: false, cut: 1.0 },
  { drums: 0, bass: false, arp: false, pad: 1.0, lead: true, riser: false, cut: 0.35 },
  { drums: 1, bass: true, arp: true, pad: 0.8, lead: false, riser: true, cut: 0.7 },
  { drums: 2, bass: true, arp: true, pad: 0.8, lead: true, riser: false, cut: 1.0 },
  { drums: 2, bass: true, arp: true, pad: 0.6, lead: true, riser: false, cut: 1.0 },
];

export class DemoTrack {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;

  private readonly bus: GainNode;
  private readonly drumBus: GainNode;
  private readonly reverbSend: GainNode;
  private readonly delaySend: GainNode;
  private readonly comp: DynamicsCompressorNode;

  private readonly noise: AudioBuffer;

  private timer: number | null = null;
  private step = 0;
  private nextTime = 0;
  private playStarted = 0;
  private accumulated = 0;
  private running = false;
  private rng = 0x9e3779b9;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(destination);

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -15;
    this.comp.knee.value = 14;
    this.comp.ratio.value = 3.5;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.16;
    this.comp.connect(this.out);

    this.bus = ctx.createGain();
    this.bus.gain.value = 0.85;
    this.bus.connect(this.comp);

    this.drumBus = ctx.createGain();
    this.drumBus.gain.value = 1.0;
    this.drumBus.connect(this.comp);

    // --- reverb: convolver fed by a procedurally generated impulse response
    const verb = ctx.createConvolver();
    verb.buffer = this.impulseResponse(2.9, 2.4);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.9;
    verb.connect(verbOut).connect(this.comp);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(verb);

    // --- dotted-eighth delay with a darkening feedback loop
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = SPB * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.4;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2600;
    delay.connect(damp).connect(fb).connect(delay);
    const delayOut = ctx.createGain();
    delayOut.gain.value = 0.55;
    delay.connect(delayOut).connect(this.comp);
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 1;
    this.delaySend.connect(delay);

    this.noise = this.noiseBuffer(2);
  }

  get elapsed(): number {
    return this.running ? this.accumulated + (this.ctx.currentTime - this.playStarted) : this.accumulated;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.playStarted = this.ctx.currentTime;
    this.nextTime = this.ctx.currentTime + 0.08;
    this.timer = window.setInterval(() => this.schedule(), TICK);
    this.schedule();
  }

  stop(): void {
    if (!this.running) return;
    this.accumulated = this.elapsed;
    this.running = false;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    setTimeout(() => this.out.disconnect(), 400);
  }

  // ------------------------------------------------------------- sequencer

  private schedule(): void {
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    while (this.nextTime < horizon) {
      this.emit(this.step, this.nextTime);
      this.step++;
      this.nextTime += STEP;
    }
  }

  private emit(step: number, time: number): void {
    const s16 = step % 16; // position in bar
    const bar = Math.floor(step / 16);
    const sectionIndex = bar < 8 ? 0 : 1 + (Math.floor(bar / 8) - 1) % 7;
    const sec = FORM[sectionIndex];
    const barInSection = bar % 8;
    const chord = PROGRESSION[Math.floor(bar / 2) % 4];
    const swing = s16 % 2 === 1 ? STEP * 0.08 : 0;
    const t = time + swing;

    // ---- drums
    if (sec.drums > 0) {
      const four = s16 % 4 === 0;
      if (s16 === 0 || s16 === 8 || (sec.drums === 2 && s16 === 10 && bar % 2 === 1)) this.kick(t, 1);
      if (sec.drums === 2 && (s16 === 4 || s16 === 12)) this.snare(t, 0.85);
      if (sec.drums === 1 && s16 === 12) this.snare(t, 0.55);
      if (sec.drums === 2 && s16 === 14 && bar % 4 === 3) this.snare(t, 0.4);
      const hatOn = sec.drums === 2 ? s16 % 2 === 0 : four;
      if (hatOn) this.hat(t, s16 === 6 || s16 === 14 ? 0.16 : 0.035, s16 % 4 === 2 ? 0.45 : 0.28);
    }

    // ---- fills and transitions
    if (barInSection === 7 && sec.drums > 0 && s16 >= 8 && s16 % 2 === 0) {
      this.snare(t, 0.25 + ((s16 - 8) / 8) * 0.5);
    }
    if (sec.riser && barInSection >= 6 && s16 === 0) {
      this.riser(t, SPB * 4 * (8 - barInSection));
    }
    if (barInSection === 0 && s16 === 0 && sectionIndex >= 2) this.impact(t);

    // ---- bass
    if (sec.bass) {
      const pattern = [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0];
      if (pattern[s16]) {
        const oct = s16 === 11 || s16 === 13 ? 12 : 0;
        this.bass(t, mtof(chord.bass + oct), STEP * 2.6, 0.55 + sec.cut * 0.2);
      }
    }

    // ---- arpeggio
    if (sec.arp && s16 % 2 === 0) {
      const idx = (step / 2) % 8;
      const shape = [0, 1, 2, 3, 2, 3, 1, 2][idx];
      const oct = idx === 5 || idx === 7 ? 12 : 0;
      this.pluck(t, mtof(chord.tones[shape] + oct), 0.28 + sec.cut * 0.25);
    }

    // ---- pad, retriggered at every chord change
    if (s16 === 0 && bar % 2 === 0 && sec.pad > 0) {
      this.pad(t, chord.pad, SPB * 8, sec.pad, 500 + sec.cut * 1800);
    }

    // ---- lead motif
    if (sec.lead && s16 === 0) {
      const beats = [0, 3, 6, 10, 12][Math.floor(this.rand() * 5)];
      const note = PENTATONIC[3 + Math.floor(this.rand() * 5)];
      this.lead(t + beats * STEP, mtof(note), STEP * (3 + Math.floor(this.rand() * 4)));
      if (this.rand() > 0.45) {
        this.lead(t + (beats + 3) * STEP, mtof(note + (this.rand() > 0.5 ? 3 : 4)), STEP * 3);
      }
    }
  }

  // ------------------------------------------------------------- instruments

  private kick(t: number, gain: number): void {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    osc.connect(g).connect(this.drumBus);
    this.life(osc, t, 0.45, [g]);

    // transient click
    const click = this.ctx.createBufferSource();
    click.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.28 * gain, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    click.connect(hp).connect(cg).connect(this.drumBus);
    this.life(click, t, 0.05, [hp, cg]);
  }

  private snare(t: number, gain: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1 + this.rand() * 0.2;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.7;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    src.connect(bp).connect(g).connect(this.drumBus);
    const send = this.ctx.createGain();
    send.gain.value = 0.12 * gain;
    g.connect(send).connect(this.reverbSend);
    this.life(src, t, 0.25, [bp, g, send]);

    const tone = this.ctx.createOscillator();
    const tg = this.ctx.createGain();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(210, t);
    tone.frequency.exponentialRampToValueAtTime(150, t + 0.09);
    tg.gain.setValueAtTime(gain * 0.35, t);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    tone.connect(tg).connect(this.drumBus);
    this.life(tone, t, 0.12, [tg]);
  }

  private hat(t: number, decay: number, gain: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1.4 + this.rand() * 0.4;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain * 0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(hp).connect(g).connect(this.drumBus);
    this.life(src, t, decay + 0.05, [hp, g]);
  }

  private impact(t: number): void {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 1.2);
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    osc.connect(g).connect(this.drumBus);
    this.life(osc, t, 1.5, [g]);

    const crash = this.ctx.createBufferSource();
    crash.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5000;
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.16, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    crash.connect(hp).connect(cg).connect(this.drumBus);
    cg.connect(this.reverbSend);
    this.life(crash, t, 1.7, [hp, cg]);
  }

  private riser(t: number, dur: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.5;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.95);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(this.bus);
    g.connect(this.reverbSend);
    this.life(src, t, dur + 0.1, [bp, g]);
  }

  private bass(t: number, freq: number, dur: number, cut: number): void {
    const saw = this.ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = freq;
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 8;
    lp.frequency.setValueAtTime(freq * 2 + 120, t);
    lp.frequency.exponentialRampToValueAtTime(freq * 2 + 120 + 1500 * cut, t + 0.05);
    lp.frequency.exponentialRampToValueAtTime(freq * 2 + 80, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const subg = this.ctx.createGain();
    subg.gain.setValueAtTime(0, t);
    subg.gain.linearRampToValueAtTime(0.42, t + 0.01);
    subg.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.9);
    saw.connect(lp).connect(g).connect(this.bus);
    sub.connect(subg).connect(this.bus);
    this.life(saw, t, dur + 0.05, [lp, g]);
    this.life(sub, t, dur + 0.05, [subg]);
  }

  private pluck(t: number, freq: number, gain: number): void {
    const a = this.ctx.createOscillator();
    a.type = 'triangle';
    a.frequency.value = freq;
    const b = this.ctx.createOscillator();
    b.type = 'sawtooth';
    b.frequency.value = freq * 1.005;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(freq * 8, t);
    lp.frequency.exponentialRampToValueAtTime(freq * 1.6, t + 0.3);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * 0.2, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.33);
    const bg = this.ctx.createGain();
    bg.gain.value = 0.35;
    a.connect(lp);
    b.connect(bg).connect(lp);
    lp.connect(g).connect(this.bus);
    const send = this.ctx.createGain();
    send.gain.value = 0.3;
    g.connect(send);
    send.connect(this.delaySend);
    send.connect(this.reverbSend);
    this.life(a, t, 0.36, [lp, g, send]);
    this.life(b, t, 0.36, [bg]);
  }

  private pad(t: number, notes: number[], dur: number, level: number, cutoff: number): void {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff * 0.6, t);
    lp.frequency.linearRampToValueAtTime(cutoff, t + dur * 0.4);
    lp.Q.value = 1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.075 * level, t + 1.1);
    g.gain.setValueAtTime(0.075 * level, t + dur - 1.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g).connect(this.bus);
    const send = this.ctx.createGain();
    send.gain.value = 0.6;
    g.connect(send).connect(this.reverbSend);

    for (const n of notes) {
      for (const detune of [-7, 7]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(n);
        o.detune.value = detune;
        const og = this.ctx.createGain();
        og.gain.value = 0.5;
        o.connect(og).connect(lp);
        this.life(o, t, dur + 0.1, [og]);
      }
    }
    setTimeout(
      () => {
        lp.disconnect();
        g.disconnect();
        send.disconnect();
      },
      (dur + 0.4 + Math.max(0, t - this.ctx.currentTime)) * 1000,
    );
  }

  private lead(t: number, freq: number, dur: number): void {
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(freq * 0.985, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.05);
    const vib = this.ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibGain = this.ctx.createGain();
    vibGain.gain.setValueAtTime(0, t);
    vibGain.gain.linearRampToValueAtTime(freq * 0.008, t + 0.25);
    vib.connect(vibGain).connect(o.frequency);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    lp.Q.value = 2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.085, t + 0.03);
    g.gain.setValueAtTime(0.085, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(this.bus);
    const send = this.ctx.createGain();
    send.gain.value = 0.5;
    g.connect(send);
    send.connect(this.delaySend);
    send.connect(this.reverbSend);
    this.life(o, t, dur + 0.1, [lp, g, send]);
    this.life(vib, t, dur + 0.1, [vibGain]);
  }

  // ------------------------------------------------------------- utilities

  /** Start a source, stop it at `t + dur`, and release its chain afterwards. */
  private life(src: OscillatorNode | AudioBufferSourceNode, t: number, dur: number, chain: AudioNode[]): void {
    src.start(t);
    src.stop(t + dur);
    src.onended = () => {
      src.disconnect();
      for (const n of chain) n.disconnect();
    };
  }

  private noiseBuffer(seconds: number): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Exponentially decaying stereo noise — a cheap but convincing hall. */
  private impulseResponse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Short pre-delay + a soft attack keeps it from sounding like a gate.
        const envelope = Math.pow(1 - t, decay) * Math.min(1, i / (rate * 0.02));
        d[i] = (Math.random() * 2 - 1) * envelope;
      }
    }
    return buf;
  }

  /** Deterministic-ish xorshift so the arrangement varies but never spikes. */
  private rand(): number {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return (this.rng % 100000) / 100000;
  }
}
