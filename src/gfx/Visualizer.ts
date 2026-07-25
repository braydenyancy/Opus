import {
  DataTexture,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
  WebGLRenderer,
  type Texture,
} from 'three';
import { NUM_BANDS, type Features } from '../audio/Analysis';
import { applyPalette, makePaletteUniforms, PALETTES, type Palette } from '../core/Palettes';
import { Post, type PostParams } from './Post';
import type { SceneContext, VisualScene } from './Scene';
import { NebulaScene } from './scenes/NebulaScene';
import { OscilloScene } from './scenes/OscilloScene';
import { TerrainScene } from './scenes/TerrainScene';
import { TunnelScene } from './scenes/TunnelScene';

const DEFAULT_POST: PostParams = {
  bloom: 0.7,
  threshold: 0.5,
  persistence: 0,
  trailZoom: 1,
  trailSpin: 0,
  aberration: 0.25,
  grain: 0.05,
  vignette: 0.75,
  exposure: 1,
};

export type SceneFactory = () => VisualScene;

export const SCENES: { id: string; title: string; make: SceneFactory }[] = [
  { id: 'nebula', title: 'Nebula', make: () => new NebulaScene() },
  { id: 'tunnel', title: 'Tunnel', make: () => new TunnelScene() },
  { id: 'terrain', title: 'Terrain', make: () => new TerrainScene() },
  { id: 'oscillo', title: 'Oscillo', make: () => new OscilloScene() },
];

export interface VisualizerSettings {
  /** Multiplies bloom. */
  glow: number;
  /** Multiplies each scene's preferred trail persistence. */
  trails: number;
  grain: number;
  autoCycle: boolean;
}

export class Visualizer {
  readonly renderer: WebGLRenderer;
  readonly settings: VisualizerSettings = { glow: 1, trails: 1, grain: 1, autoCycle: false };

  sceneIndex = 0;
  paletteIndex = 0;
  fps = 60;
  renderScale = 1;

  private readonly canvas: HTMLCanvasElement;
  private readonly post: Post;
  private readonly paletteUniforms = makePaletteUniforms();
  private readonly audioTexture: DataTexture;
  private readonly audioData: Float32Array;

  private current: VisualScene;
  private outgoing: VisualScene | null = null;
  private transition = 1;

  private paletteFrom: Palette = PALETTES[0];
  private paletteTo: Palette = PALETTES[0];
  private paletteT = 1;

  private width = 1;
  private height = 1;
  private dpr = 1;
  private frameTime = 16;
  private adaptTimer = 0;
  private quality = 1;
  private lastCycle = 0;
  private captureRequest: ((url: string) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 1);

    // Rough capability probe so weak GPUs start conservative.
    const gl = this.renderer.getContext();
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.quality = maxTex >= 8192 ? 1 : 0.7;

    this.audioData = new Float32Array(NUM_BANDS * 4);
    this.audioTexture = new DataTexture(this.audioData, NUM_BANDS, 1, RGBAFormat, FloatType);
    this.audioTexture.minFilter = LinearFilter;
    this.audioTexture.magFilter = LinearFilter;
    this.audioTexture.needsUpdate = true;

    this.post = new Post(this.renderer);

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.measure();

    this.current = SCENES[0].make();
    this.current.init(this.context());
    this.applyPaletteNow(0);
  }

  private context(): SceneContext {
    return {
      renderer: this.renderer,
      audio: this.audioTexture as Texture,
      palette: this.paletteUniforms,
      width: this.bufferWidth,
      height: this.bufferHeight,
      quality: this.quality,
    };
  }

  private get bufferWidth(): number {
    return Math.max(2, Math.floor(this.width * this.dpr * this.renderScale));
  }

  private get bufferHeight(): number {
    return Math.max(2, Math.floor(this.height * this.dpr * this.renderScale));
  }

  private measure(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width || window.innerWidth);
    this.height = Math.max(1, rect.height || window.innerHeight);
  }

  resize(): void {
    this.measure();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.applyBufferSize();
  }

  private applyBufferSize(): void {
    const w = this.bufferWidth;
    const h = this.bufferHeight;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.post.setSize(w, h);
    this.current.resize(w, h);
    this.outgoing?.resize(w, h);
  }

  // ------------------------------------------------------------------ scenes

  setScene(index: number): void {
    const next = ((index % SCENES.length) + SCENES.length) % SCENES.length;
    if (next === this.sceneIndex && this.transition >= 1) return;
    if (this.outgoing) {
      this.outgoing.dispose();
      this.outgoing = null;
    }
    this.outgoing = this.current;
    this.sceneIndex = next;
    this.current = SCENES[next].make();
    this.current.init(this.context());
    this.transition = 0;
    this.post.clearHistory();
  }

  nextScene(delta = 1): void {
    this.setScene(this.sceneIndex + delta);
  }

  get sceneTitle(): string {
    return this.current.title;
  }

  get sceneBlurb(): string {
    return this.current.blurb;
  }

  // ---------------------------------------------------------------- palettes

  setPalette(index: number): void {
    const next = ((index % PALETTES.length) + PALETTES.length) % PALETTES.length;
    if (next === this.paletteIndex) return;
    this.paletteFrom = PALETTES[this.paletteIndex];
    this.paletteTo = PALETTES[next];
    this.paletteIndex = next;
    this.paletteT = 0;
  }

  private applyPaletteNow(index: number): void {
    this.paletteIndex = index;
    this.paletteFrom = PALETTES[index];
    this.paletteTo = PALETTES[index];
    this.paletteT = 1;
    applyPalette(this.paletteUniforms, this.paletteFrom, this.paletteTo, 1);
  }

  get palette(): Palette {
    return PALETTES[this.paletteIndex];
  }

  // ------------------------------------------------------------------- frame

  frame(dt: number, f: Features): void {
    this.updateAudioTexture(f);

    this.paletteT = Math.min(1, this.paletteT + dt / 0.8);
    applyPalette(this.paletteUniforms, this.paletteFrom, this.paletteTo, this.paletteT);

    if (this.settings.autoCycle && f.beatCount - this.lastCycle > 64) {
      this.lastCycle = f.beatCount;
      this.nextScene(1);
    }

    const cutting = this.transition < 1;
    if (cutting) this.transition = Math.min(1, this.transition + dt / 0.6);
    const showOutgoing = cutting && this.transition < 0.45 && this.outgoing !== null;

    const active = showOutgoing ? (this.outgoing as VisualScene) : this.current;
    active.update(dt, f);
    active.render(this.renderer, this.post.scene);

    if (!cutting && this.outgoing) {
      this.outgoing.dispose();
      this.outgoing = null;
    }

    this.post.render(this.resolvePost(f, cutting), f.time);

    if (this.captureRequest) {
      const cb = this.captureRequest;
      this.captureRequest = null;
      cb(this.canvas.toDataURL('image/png'));
    }

    this.adapt(dt);
  }

  private resolvePost(f: Features, cutting: boolean): PostParams {
    const p: PostParams = { ...DEFAULT_POST, ...this.current.post };
    p.bloom *= this.settings.glow * (0.85 + f.level * 0.5);
    p.persistence = Math.min(0.95, p.persistence * this.settings.trails);
    p.grain *= this.settings.grain;
    p.exposure *= 1 + f.beat * 0.07 + f.drift * 0.06;
    p.aberration *= 1 + f.flux * 1.2;

    if (cutting) {
      // Cut through black: dip the exposure and smear the aberration.
      const t = this.transition;
      const dip = Math.abs(Math.cos(Math.PI * t));
      p.exposure *= dip * dip;
      p.aberration += (1 - dip) * 2.5;
      p.persistence = 0;
    }
    return p;
  }

  private updateAudioTexture(f: Features): void {
    const wave = f.wave;
    const stride = Math.max(1, Math.floor(wave.length / NUM_BANDS));
    for (let i = 0; i < NUM_BANDS; i++) {
      this.audioData[i * 4 + 0] = f.bands[i];
      this.audioData[i * 4 + 1] = f.peaks[i];
      this.audioData[i * 4 + 2] = wave[i * stride] ?? 0;
      this.audioData[i * 4 + 3] = f.chroma[i % 12];
    }
    this.audioTexture.needsUpdate = true;
  }

  /** Keep the frame budget by trading resolution, not visual features. */
  private adapt(dt: number): void {
    this.frameTime += (dt * 1000 - this.frameTime) * 0.08;
    this.fps = 1000 / Math.max(this.frameTime, 1);
    this.adaptTimer += dt;
    if (this.adaptTimer < 0.9) return;
    this.adaptTimer = 0;

    const before = this.renderScale;
    if (this.frameTime > 22 && this.renderScale > 0.55) this.renderScale = Math.max(0.55, this.renderScale - 0.1);
    else if (this.frameTime < 13.5 && this.renderScale < 1) this.renderScale = Math.min(1, this.renderScale + 0.05);
    if (Math.abs(before - this.renderScale) > 0.001) this.applyBufferSize();
  }

  capture(): Promise<string> {
    return new Promise((resolve) => {
      this.captureRequest = resolve;
    });
  }

  dispose(): void {
    this.current.dispose();
    this.outgoing?.dispose();
    this.post.dispose();
    this.audioTexture.dispose();
    this.renderer.dispose();
  }
}
