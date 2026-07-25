import type { Camera, Scene, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
import type { Features } from '../audio/Analysis';
import type { PaletteUniforms } from '../core/Palettes';
import type { PostParams } from './Post';

export interface SceneContext {
  renderer: WebGLRenderer;
  /** 128×1 RGBA float texture: r = band, g = peak, b = waveform, a = chroma. */
  audio: Texture;
  palette: PaletteUniforms;
  width: number;
  height: number;
  /** 0.5 … 1 — lower on weak GPUs; scenes may shed work accordingly. */
  quality: number;
}

export interface VisualScene {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  /** Post-processing preferences for this scene. */
  readonly post: Partial<PostParams>;

  init(ctx: SceneContext): void;
  resize(width: number, height: number): void;
  update(dt: number, f: Features): void;
  render(renderer: WebGLRenderer, target: WebGLRenderTarget): void;
  dispose(): void;
}

/** Shared plumbing: holds the three.js scene/camera and the default render call. */
export abstract class BaseScene implements VisualScene {
  abstract readonly id: string;
  abstract readonly title: string;
  abstract readonly blurb: string;
  readonly post: Partial<PostParams> = {};

  protected scene!: Scene;
  protected camera!: Camera;
  protected ctx!: SceneContext;

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    this.build();
    this.resize(ctx.width, ctx.height);
  }

  protected abstract build(): void;
  abstract resize(width: number, height: number): void;
  abstract update(dt: number, f: Features): void;

  render(renderer: WebGLRenderer, target: WebGLRenderTarget): void {
    renderer.setRenderTarget(target);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.scene.traverse((obj) => {
      const any = obj as unknown as {
        geometry?: { dispose(): void };
        material?: { dispose(): void } | { dispose(): void }[];
      };
      any.geometry?.dispose();
      const m = any.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
  }
}
