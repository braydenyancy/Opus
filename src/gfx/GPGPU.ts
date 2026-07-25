import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  NearestFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { Quad } from './Quad';
import { SCREEN_VERT } from './glsl';

const targetOptions = {
  type: FloatType,
  format: RGBAFormat,
  minFilter: NearestFilter,
  magFilter: NearestFilter,
  wrapS: ClampToEdgeWrapping,
  wrapT: ClampToEdgeWrapping,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
} as const;

/**
 * A double-buffered float texture plus the shader that advances it.
 * Everything the particle system needs, and nothing it doesn't.
 */
export class SimBuffer {
  private front: WebGLRenderTarget;
  private back: WebGLRenderTarget;
  private readonly quad: Quad;

  constructor(
    renderer: WebGLRenderer,
    readonly size: number,
    seed: Float32Array,
    fragmentShader: string,
    uniforms: Record<string, { value: unknown }>,
  ) {
    this.front = new WebGLRenderTarget(size, size, targetOptions);
    this.back = new WebGLRenderTarget(size, size, targetOptions);

    this.quad = new Quad(
      new ShaderMaterial({
        vertexShader: SCREEN_VERT,
        fragmentShader,
        uniforms: { tState: { value: null }, ...uniforms },
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
      }),
    );

    // Seed both buffers from CPU data via a one-off copy pass.
    const seedTex = new DataTexture(seed, size, size, RGBAFormat, FloatType);
    seedTex.needsUpdate = true;
    const copy = new Quad(
      new ShaderMaterial({
        vertexShader: SCREEN_VERT,
        fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tState;
          void main() { gl_FragColor = texture2D(tState, vUv); }`,
        uniforms: { tState: { value: seedTex } },
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
      }),
    );
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    copy.render(renderer, this.front);
    copy.render(renderer, this.back);
    renderer.autoClear = prevAuto;
    renderer.setRenderTarget(null);
    copy.dispose();
    seedTex.dispose();
  }

  get texture(): Texture {
    return this.front.texture;
  }

  get uniforms(): Record<string, { value: unknown }> {
    return this.quad.material.uniforms as Record<string, { value: unknown }>;
  }

  step(renderer: WebGLRenderer): void {
    this.quad.material.uniforms.tState.value = this.front.texture;
    this.quad.render(renderer, this.back);
    const swap = this.front;
    this.front = this.back;
    this.back = swap;
  }

  dispose(): void {
    this.front.dispose();
    this.back.dispose();
    this.quad.dispose();
  }
}
