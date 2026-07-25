import {
  AdditiveBlending,
  HalfFloatType,
  LinearFilter,
  NoBlending,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { Quad } from './Quad';
import { HASH, ROT, SCREEN_VERT } from './glsl';

export interface PostParams {
  bloom: number;
  threshold: number;
  /** 0 disables the feedback buffer entirely. */
  persistence: number;
  trailZoom: number;
  trailSpin: number;
  aberration: number;
  grain: number;
  vignette: number;
  exposure: number;
}

const MIP_COUNT = 5;

/**
 * A compact HDR post chain: optional frame feedback, dual-filter bloom
 * (Kawase down / tent up), then a single composite pass that does chromatic
 * aberration, ACES tone mapping, vignette, grain and dithering in one go.
 */
export class Post {
  scene: WebGLRenderTarget;

  private readonly renderer: WebGLRenderer;
  private feedbackA: WebGLRenderTarget;
  private feedbackB: WebGLRenderTarget;
  private readonly mips: WebGLRenderTarget[] = [];

  private readonly feedbackQuad: Quad;
  private readonly prefilterQuad: Quad;
  private readonly downQuad: Quad;
  private readonly upQuad: Quad;
  private readonly compositeQuad: Quad;

  private width = 1;
  private height = 1;
  private hasHistory = false;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;

    const rt = (w: number, h: number, depth: boolean) =>
      new WebGLRenderTarget(w, h, {
        type: HalfFloatType,
        depthBuffer: depth,
        stencilBuffer: false,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        generateMipmaps: false,
      });

    this.scene = rt(1, 1, true);
    this.feedbackA = rt(1, 1, false);
    this.feedbackB = rt(1, 1, false);
    for (let i = 0; i < MIP_COUNT; i++) this.mips.push(rt(1, 1, false));

    this.feedbackQuad = new Quad(
      new ShaderMaterial({
        vertexShader: SCREEN_VERT,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying vec2 vUv;
          uniform sampler2D tSrc;
          uniform sampler2D tPrev;
          uniform float uPersist;
          uniform float uZoom;
          uniform float uSpin;
          uniform float uAspect;
          ${ROT}
          void main() {
            vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
            c = rot(uSpin) * c * uZoom;
            c = c / vec2(uAspect, 1.0) + 0.5;
            vec3 prev = texture2D(tPrev, c).rgb;
            // Trails fade towards cool shadow rather than pure grey.
            prev *= vec3(0.995, 0.998, 1.004);
            vec3 src = texture2D(tSrc, vUv).rgb;
            gl_FragColor = vec4(max(src, prev * uPersist), 1.0);
          }
        `,
        uniforms: {
          tSrc: { value: null },
          tPrev: { value: null },
          uPersist: { value: 0.9 },
          uZoom: { value: 1.0 },
          uSpin: { value: 0.0 },
          uAspect: { value: 1.0 },
        },
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
      }),
    );

    this.prefilterQuad = new Quad(
      new ShaderMaterial({
        vertexShader: SCREEN_VERT,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying vec2 vUv;
          uniform sampler2D tSrc;
          uniform float uThreshold;
          void main() {
            vec3 c = texture2D(tSrc, vUv).rgb;
            float br = max(c.r, max(c.g, c.b));
            float knee = uThreshold * 0.7 + 1e-4;
            float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
            soft = soft * soft / (4.0 * knee);
            float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
            gl_FragColor = vec4(c * contrib, 1.0);
          }
        `,
        uniforms: { tSrc: { value: null }, uThreshold: { value: 0.7 } },
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
      }),
    );

    this.downQuad = new Quad(
      new ShaderMaterial({
        vertexShader: SCREEN_VERT,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying vec2 vUv;
          uniform sampler2D tSrc;
          uniform vec2 uTexel;
          vec3 T(vec2 o) { return texture2D(tSrc, vUv + uTexel * o).rgb; }
          void main() {
            vec3 a = T(vec2(-2.0, 2.0)), b = T(vec2(0.0, 2.0)), c = T(vec2(2.0, 2.0));
            vec3 d = T(vec2(-2.0, 0.0)), e = T(vec2(0.0, 0.0)), f = T(vec2(2.0, 0.0));
            vec3 g = T(vec2(-2.0, -2.0)), h = T(vec2(0.0, -2.0)), i = T(vec2(2.0, -2.0));
            vec3 j = T(vec2(-1.0, 1.0)), k = T(vec2(1.0, 1.0));
            vec3 l = T(vec2(-1.0, -1.0)), m = T(vec2(1.0, -1.0));
            vec3 col = e * 0.125
              + (a + c + g + i) * 0.03125
              + (b + d + f + h) * 0.0625
              + (j + k + l + m) * 0.125;
            gl_FragColor = vec4(col, 1.0);
          }
        `,
        uniforms: { tSrc: { value: null }, uTexel: { value: new Vector2() } },
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
      }),
    );

    this.upQuad = new Quad(
      new ShaderMaterial({
        vertexShader: SCREEN_VERT,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying vec2 vUv;
          uniform sampler2D tSrc;
          uniform vec2 uTexel;
          uniform float uRadius;
          vec3 T(vec2 o) { return texture2D(tSrc, vUv + uTexel * o * uRadius).rgb; }
          void main() {
            vec3 col = T(vec2(-1.0, 1.0)) + T(vec2(0.0, 1.0)) * 2.0 + T(vec2(1.0, 1.0))
                     + T(vec2(-1.0, 0.0)) * 2.0 + T(vec2(0.0, 0.0)) * 4.0 + T(vec2(1.0, 0.0)) * 2.0
                     + T(vec2(-1.0, -1.0)) + T(vec2(0.0, -1.0)) * 2.0 + T(vec2(1.0, -1.0));
            gl_FragColor = vec4(col / 16.0, 1.0);
          }
        `,
        uniforms: { tSrc: { value: null }, uTexel: { value: new Vector2() }, uRadius: { value: 1.0 } },
        depthTest: false,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );

    this.compositeQuad = new Quad(
      new ShaderMaterial({
        vertexShader: SCREEN_VERT,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying vec2 vUv;
          uniform sampler2D tScene;
          uniform sampler2D tBloom;
          uniform float uBloom;
          uniform float uAberration;
          uniform float uGrain;
          uniform float uVignette;
          uniform float uExposure;
          uniform float uTime;
          ${HASH}
          vec3 aces(vec3 x) {
            return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
          }
          void main() {
            vec2 d = vUv - 0.5;
            vec2 off = d * dot(d, d) * uAberration;
            vec3 col;
            col.r = texture2D(tScene, vUv + off).r;
            col.g = texture2D(tScene, vUv).g;
            col.b = texture2D(tScene, vUv - off).b;
            vec3 bl;
            bl.r = texture2D(tBloom, vUv + off * 2.0).r;
            bl.g = texture2D(tBloom, vUv).g;
            bl.b = texture2D(tBloom, vUv - off * 2.0).b;
            col += bl * uBloom;
            col *= uExposure;
            col = aces(col);
            float v = smoothstep(1.15, 0.30, length(d) * 1.42);
            col *= mix(1.0, v, uVignette);
            // Weight the grain by luminance: film noise lives in the mids, not
            // in the blacks, and unweighted noise makes dark scenes look dirty.
            float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
            float n = hash12(gl_FragCoord.xy + fract(uTime) * 311.7);
            col += (n - 0.5) * uGrain * (0.15 + 1.6 * lum * (1.0 - lum));
            col += (hash12(gl_FragCoord.xy * 1.37) - 0.5) * (1.0 / 255.0);
            gl_FragColor = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
          }
        `,
        uniforms: {
          tScene: { value: null },
          tBloom: { value: null },
          uBloom: { value: 0.6 },
          uAberration: { value: 0.25 },
          uGrain: { value: 0.035 },
          uVignette: { value: 0.75 },
          uExposure: { value: 1.0 },
          uTime: { value: 0 },
        },
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
      }),
    );
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(2, Math.floor(width));
    this.height = Math.max(2, Math.floor(height));
    this.scene.setSize(this.width, this.height);
    this.feedbackA.setSize(this.width, this.height);
    this.feedbackB.setSize(this.width, this.height);
    for (let i = 0; i < MIP_COUNT; i++) {
      const div = 2 << i;
      this.mips[i].setSize(Math.max(2, Math.floor(this.width / div)), Math.max(2, Math.floor(this.height / div)));
    }
    this.hasHistory = false;
  }

  /** Discard the trail history — used when switching scenes. */
  clearHistory(): void {
    this.hasHistory = false;
  }

  render(params: PostParams, time: number): void {
    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    let source = this.scene;

    if (params.persistence > 0.001) {
      if (!this.hasHistory) {
        r.setRenderTarget(this.feedbackB);
        r.clear(true, false, false);
        this.hasHistory = true;
      }
      const m = this.feedbackQuad.material;
      m.uniforms.tSrc.value = this.scene.texture;
      m.uniforms.tPrev.value = this.feedbackB.texture;
      m.uniforms.uPersist.value = params.persistence;
      m.uniforms.uZoom.value = params.trailZoom;
      m.uniforms.uSpin.value = params.trailSpin;
      m.uniforms.uAspect.value = this.width / this.height;
      this.feedbackQuad.render(r, this.feedbackA);
      source = this.feedbackA;
      const swap = this.feedbackA;
      this.feedbackA = this.feedbackB;
      this.feedbackB = swap;
    } else {
      this.hasHistory = false;
    }

    // --- bloom: prefilter, downsample chain, additive tent upsample
    const pf = this.prefilterQuad.material;
    pf.uniforms.tSrc.value = source.texture;
    pf.uniforms.uThreshold.value = params.threshold;
    this.prefilterQuad.render(r, this.mips[0]);

    const dm = this.downQuad.material;
    for (let i = 1; i < MIP_COUNT; i++) {
      const src = this.mips[i - 1];
      dm.uniforms.tSrc.value = src.texture;
      (dm.uniforms.uTexel.value as Vector2).set(1 / src.width, 1 / src.height);
      this.downQuad.render(r, this.mips[i]);
    }

    const um = this.upQuad.material;
    um.uniforms.uRadius.value = 1.0;
    for (let i = MIP_COUNT - 1; i > 0; i--) {
      const src = this.mips[i];
      um.uniforms.tSrc.value = src.texture;
      (um.uniforms.uTexel.value as Vector2).set(1 / src.width, 1 / src.height);
      this.upQuad.render(r, this.mips[i - 1], false);
    }

    const cm = this.compositeQuad.material;
    cm.uniforms.tScene.value = source.texture;
    cm.uniforms.tBloom.value = this.mips[0].texture;
    cm.uniforms.uBloom.value = params.bloom;
    cm.uniforms.uAberration.value = params.aberration;
    cm.uniforms.uGrain.value = params.grain;
    cm.uniforms.uVignette.value = params.vignette;
    cm.uniforms.uExposure.value = params.exposure;
    cm.uniforms.uTime.value = time;
    this.compositeQuad.render(r, null, false);

    r.autoClear = prevAutoClear;
    r.setRenderTarget(null);
  }

  dispose(): void {
    this.scene.dispose();
    this.feedbackA.dispose();
    this.feedbackB.dispose();
    for (const m of this.mips) m.dispose();
    this.feedbackQuad.dispose();
    this.prefilterQuad.dispose();
    this.downQuad.dispose();
    this.upQuad.dispose();
    this.compositeQuad.dispose();
  }
}
