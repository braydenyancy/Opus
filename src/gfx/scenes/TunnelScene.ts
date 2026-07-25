import { ShaderMaterial, Vector2, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import type { Features } from '../../audio/Analysis';
import { AUDIO_TEX, HASH, PALETTE, ROT, SCREEN_VERT } from '../glsl';
import { Quad } from '../Quad';
import type { PostParams } from '../Post';
import type { SceneContext, VisualScene } from '../Scene';

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime;
uniform float uZ;
uniform float uTwist;
uniform float uBass;
uniform float uHigh;
uniform float uLevel;
uniform float uBeat;
uniform float uHue;
uniform float uWarp;
uniform float uSteps;
uniform float uRoll;
${HASH}
${ROT}
${AUDIO_TEX}
${PALETTE}

float map(vec3 p, out float ang) {
  p.xy *= rot(p.z * 0.03 + uTwist);
  // The axis wanders, but never far enough to put the camera inside a wall.
  p.xy -= vec2(sin(p.z * 0.12 + uTime * 0.31), cos(p.z * 0.09 + uTime * 0.23)) * uWarp;
  float a = atan(p.y, p.x);
  ang = a;
  float r = length(p.xy);
  // Fold the spectrum around the tunnel so it is symmetric left/right.
  float spec = band(abs(fract(a / 6.28318530718 + 0.5) * 2.0 - 1.0));
  float radius = 4.6 + spec * 2.4 + uBass * 1.2;
  // Rings passing the camera give the corridor its sense of travel; the
  // flutes run straight down the axis so they read as grooves, not a spiral.
  float rings = 0.34 * sin(p.z * 1.15 - uTime * 2.2);
  float flutes = 0.11 * sin(a * 12.0) * (0.3 + uHigh * 1.2);
  return radius - r + rings + flutes;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 ro = vec3(0.0, 0.0, uZ);
  vec3 rd = normalize(vec3(uv, 2.3));
  rd.xy *= rot(uRoll);

  float t = 0.6;
  vec3 col = vec3(0.0);
  float ang = 0.0;
  // Dithered start offset removes the concentric banding that fixed steps give.
  t += hash12(gl_FragCoord.xy) * 0.35;

  for (int i = 0; i < 96; i++) {
    if (float(i) > uSteps) break;
    vec3 p = ro + rd * t;
    float d = map(p, ang);
    float ds = max(0.16, abs(d) * 0.6);
    // Tight falloff keeps the wall a defined ribbon of light, not a wash.
    float glow = exp(-abs(d) * 7.5);
    // Weighting by step length makes this an actual integral along the ray, so
    // grazing angles stop piling up hundreds of equal-weight samples.
    float depth = exp(-t * 0.032) * smoothstep(0.0, 3.0, t);
    float hue = fract(uHue + p.z * 0.0045 + ang * 0.022);
    col += palette(hue) * glow * depth * ds * 2.3;
    t += ds;
    // Stop at the first wall. Marching on would accumulate every ring the ray
    // passes *behind* the wall, which is what turns the corridor into soup.
    if (d < 0.0 || t > 90.0) break;
  }

  // Core flare on transients.
  float rr = length(uv);
  col += palette(fract(uHue + 0.45)) * uBeat * 0.09 * exp(-rr * 4.5);
  // A breath of light at the vanishing point so the far end reads as distance.
  col += palette(fract(uHue + 0.12)) * exp(-rr * rr * 11.0) * (0.02 + uLevel * 0.05);
  // Draw the eye down the corridor rather than out to the corners.
  col *= mix(1.0, exp(-rr * 1.1), 0.7);
  col *= 0.5 + uLevel * 0.85;

  gl_FragColor = vec4(col, 1.0);
}
`;

/** A volumetric raymarched corridor. The spectrum is the wall profile. */
export class TunnelScene implements VisualScene {
  readonly id = 'tunnel';
  readonly title = 'Tunnel';
  readonly blurb = 'raymarched corridor · the spectrum is the wall';
  readonly post: Partial<PostParams> = {
    bloom: 0.6,
    threshold: 0.45,
    persistence: 0,
    aberration: 0.45,
    exposure: 1.05,
    vignette: 0.85,
  };

  private quad!: Quad;
  private ctx!: SceneContext;
  private z = 0;
  private twist = 0;
  private roll = 0;

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    this.quad = new Quad(
      new ShaderMaterial({
        vertexShader: SCREEN_VERT,
        fragmentShader: FRAG,
        uniforms: {
          uRes: { value: new Vector2(ctx.width, ctx.height) },
          uAudio: { value: ctx.audio },
          uTime: { value: 0 },
          uZ: { value: 0 },
          uTwist: { value: 0 },
          uBass: { value: 0 },
          uHigh: { value: 0 },
          uLevel: { value: 0 },
          uBeat: { value: 0 },
          uHue: { value: 0 },
          uWarp: { value: 1 },
          uRoll: { value: 0 },
          uSteps: { value: 72 },
          ...ctx.palette,
        },
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.resize(ctx.width, ctx.height);
  }

  resize(width: number, height: number): void {
    (this.quad.material.uniforms.uRes.value as Vector2).set(width, height);
    const megapixels = (width * height) / 1e6;
    // Keep the marcher inside budget on large canvases.
    this.quad.material.uniforms.uSteps.value = Math.round(
      Math.max(34, Math.min(90, 88 / Math.max(0.6, megapixels)) * this.ctx.quality),
    );
  }

  update(dt: number, f: Features): void {
    const u = this.quad.material.uniforms;
    this.z += dt * (7 + f.level * 22 + f.beat * 9);
    this.twist += dt * (0.12 + f.high * 0.85) * (f.barPhase > 0.5 ? 1 : -0.7);
    this.roll += dt * 0.08 * Math.sin(f.time * 0.17);
    u.uTime.value = f.time;
    u.uZ.value = this.z;
    u.uTwist.value = this.twist;
    u.uBass.value = f.bass;
    u.uHigh.value = f.high;
    u.uLevel.value = f.level;
    u.uBeat.value = f.beat;
    u.uHue.value = f.hue;
    u.uWarp.value = 0.15 + f.lowMid * 0.65;
    u.uRoll.value = this.roll + Math.sin(f.time * 0.21) * 0.1;
  }

  render(renderer: WebGLRenderer, target: WebGLRenderTarget): void {
    this.quad.render(renderer, target);
  }

  dispose(): void {
    this.quad.dispose();
  }
}
