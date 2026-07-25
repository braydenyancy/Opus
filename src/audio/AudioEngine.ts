import { DemoTrack } from './DemoTrack';

export type SourceKind = 'demo' | 'file' | 'mic';

export interface SourceInfo {
  kind: SourceKind;
  /** Human readable label for the UI. */
  label: string;
  /** Seconds, or 0 when the source is open-ended (mic / generative). */
  duration: number;
}

/**
 * Owns the WebAudio graph and everything that can feed it.
 *
 *   [source] -> preGain -+-> masterGain -> destination
 *                        `-> analyser            (leaf — measured, not heard)
 *
 * The analyser hangs off the graph as a leaf so the microphone can be routed
 * into it alone: live input is measured but never played back, which is the
 * only way to avoid a howl-round through the user's speakers.
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  readonly freq: Float32Array<ArrayBuffer>;
  readonly wave: Float32Array<ArrayBuffer>;

  private readonly preGain: GainNode;
  private readonly master: GainNode;

  private demo: DemoTrack | null = null;
  private buffer: AudioBuffer | null = null;
  private bufferNode: AudioBufferSourceNode | null = null;
  private micStream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private micConnected = false;

  private startedAt = 0;
  private offset = 0;
  private playing = false;

  info: SourceInfo = { kind: 'demo', label: 'Generative — "Parallax"', duration: 0 };
  onEnded: (() => void) | null = null;

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });

    this.preGain = this.ctx.createGain();
    this.master = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    // We run our own attack/release envelopes, so keep the raw signal here.
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.minDecibels = -100;
    this.analyser.maxDecibels = -6;

    this.preGain.connect(this.analyser);
    this.preGain.connect(this.master);
    this.master.connect(this.ctx.destination);

    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.wave = new Float32Array(2048);
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get volume(): number {
    return this.master.gain.value;
  }

  set volume(v: number) {
    this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.02);
  }

  /** Playback position in seconds (0 for open-ended sources). */
  get position(): number {
    if (this.info.kind === 'file') {
      const t = this.playing ? this.offset + (this.ctx.currentTime - this.startedAt) : this.offset;
      return this.buffer ? Math.min(t, this.buffer.duration) : 0;
    }
    if (this.info.kind === 'demo' && this.demo) return this.demo.elapsed;
    return 0;
  }

  sample(): void {
    this.analyser.getFloatFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.wave);
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  // ---------------------------------------------------------------- sources

  async useDemo(): Promise<void> {
    this.teardown();
    this.demo = new DemoTrack(this.ctx, this.preGain);
    this.info = { kind: 'demo', label: 'Generative — "Parallax"', duration: 0 };
    await this.play();
  }

  async useFile(file: File): Promise<void> {
    const bytes = await file.arrayBuffer();
    const decoded = await this.ctx.decodeAudioData(bytes);
    this.teardown();
    this.buffer = decoded;
    this.offset = 0;
    this.info = {
      kind: 'file',
      label: file.name.replace(/\.[a-z0-9]+$/i, ''),
      duration: decoded.duration,
    };
    await this.play();
  }

  async useMic(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.teardown();
    this.micStream = stream;
    this.micNode = this.ctx.createMediaStreamSource(stream);
    // Straight to the analyser, deliberately skipping `master`.
    this.micNode.connect(this.analyser);
    this.micConnected = true;
    this.info = { kind: 'mic', label: 'Live input', duration: 0 };
    this.playing = true;
    await this.resume();
  }

  // ------------------------------------------------------------- transport

  async play(): Promise<void> {
    await this.resume();
    if (this.playing) return;
    switch (this.info.kind) {
      case 'demo':
        this.demo?.start();
        break;
      case 'file':
        this.startBufferNode(this.offset);
        break;
      case 'mic':
        if (this.micNode && !this.micConnected) {
          this.micNode.connect(this.analyser);
          this.micConnected = true;
        }
        break;
    }
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    switch (this.info.kind) {
      case 'demo':
        this.demo?.stop();
        break;
      case 'file':
        this.offset = this.position;
        this.stopBufferNode();
        break;
      case 'mic':
        // Stop measuring, but keep the stream open so resuming is instant.
        this.micNode?.disconnect();
        this.micConnected = false;
        break;
    }
    this.playing = false;
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(seconds: number): void {
    if (this.info.kind !== 'file' || !this.buffer) return;
    const t = Math.max(0, Math.min(seconds, this.buffer.duration - 0.05));
    this.offset = t;
    if (this.playing) {
      this.stopBufferNode();
      this.startBufferNode(t);
    }
  }

  private startBufferNode(offset: number): void {
    if (!this.buffer) return;
    const node = this.ctx.createBufferSource();
    node.buffer = this.buffer;
    node.connect(this.preGain);
    node.onended = () => {
      if (this.bufferNode !== node) return; // superseded by a seek
      this.playing = false;
      this.offset = 0;
      this.bufferNode = null;
      this.onEnded?.();
    };
    node.start(0, offset);
    this.startedAt = this.ctx.currentTime;
    this.bufferNode = node;
  }

  private stopBufferNode(): void {
    if (!this.bufferNode) return;
    const node = this.bufferNode;
    this.bufferNode = null;
    node.onended = null;
    try {
      node.stop();
    } catch {
      /* already stopped */
    }
    node.disconnect();
  }

  private teardown(): void {
    this.demo?.dispose();
    this.demo = null;
    this.stopBufferNode();
    this.buffer = null;
    this.offset = 0;
    this.micNode?.disconnect();
    this.micNode = null;
    this.micConnected = false;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.playing = false;
  }
}
