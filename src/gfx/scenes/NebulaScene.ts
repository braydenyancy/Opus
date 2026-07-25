import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  type WebGLRenderer,
} from 'three';
import type { Features } from '../../audio/Analysis';
import { SimBuffer } from '../GPGPU';
import { AUDIO_TEX, HASH, PALETTE, SIMPLEX3 } from '../glsl';
import { BaseScene } from '../Scene';
import type { PostParams } from '../Post';

const COMMON = `precision highp float;\nvarying vec2 vUv;\n${HASH}\n${AUDIO_TEX}\n`;

const VELOCITY_SHADER = /* glsl */ `
${COMMON}
${SIMPLEX3}
uniform sampler2D tState;   // xyz velocity, w seed
uniform sampler2D tPos;     // xyz position, w age
uniform float uDt;
uniform float uTime;
uniform float uFlow;
uniform float uSwirl;
uniform float uPulse;
uniform float uRadius;
uniform float uDamp;
uniform float uFlatten;

void main() {
  vec4 st = texture2D(tState, vUv);
  vec3 vel = st.xyz;
  float seed = st.w;
  vec3 pos = texture2D(tPos, vUv).xyz;

  float b = band(seed);
  float r = length(pos) + 1e-4;
  vec3 dir = pos / r;

  // Turbulence — the field itself breathes with the mid band.
  vec3 force = curl(pos * 0.075 + vec3(0.0, 0.0, uTime * 0.05), 0.4) * uFlow * (0.5 + b * 1.1);

  // Differential rotation: inner orbits are faster, which winds the noise into
  // spiral arms instead of leaving an undifferentiated ball.
  force += vec3(-pos.z, 0.0, pos.x) * uSwirl * (1.6 / (0.5 + r * 0.09));

  // Collapse towards a disc so the structure reads as arms, not fog.
  force.y -= pos.y * uFlatten;

  // Each particle belongs to one frequency band and orbits on that band's ring,
  // so the whole galaxy is a spectrum seen from above.
  float targetR = uRadius * (0.22 + seed * 1.0 + b * 0.5);
  force -= dir * (r - targetR) * 1.15;

  // Onsets fire a shockwave outward from the core.
  force += dir * uPulse * exp(-r * 0.09) * (0.5 + b);

  vel += force * uDt;
  vel *= exp(-uDt * uDamp);
  vel = clamp(vel, vec3(-40.0), vec3(40.0));

  gl_FragColor = vec4(vel, seed);
}
`;

const POSITION_SHADER = /* glsl */ `
${COMMON}
uniform sampler2D tState;   // xyz position, w age
uniform sampler2D tVel;
uniform float uDt;
uniform float uTime;
uniform float uRadius;

void main() {
  vec4 st = texture2D(tState, vUv);
  vec3 pos = st.xyz;
  float age = st.w;
  vec4 v = texture2D(tVel, vUv);

  pos += v.xyz * uDt;
  age += uDt;

  float life = 7.0 + hash11(v.w * 131.7) * 7.0;
  if (age > life) {
    age = 0.0;
    vec3 rnd = hash31(v.w * 733.1 + floor(uTime * 7.0)) * 2.0 - 1.0;
    pos = normalize(rnd + 1e-4) * uRadius * (0.30 + v.w * 1.05);
  }

  gl_FragColor = vec4(pos, age);
}
`;

const RENDER_VERT = /* glsl */ `
precision highp float;
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform float uSize;
uniform float uPixelRatio;
uniform float uHue;
uniform float uGlow;
${HASH}
${AUDIO_TEX}
${PALETTE}
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 ref = position.xy;
  vec4 ps = texture2D(tPos, ref);
  vec4 vs = texture2D(tVel, ref);
  float seed = vs.w;
  float b = band(seed);
  float speed = length(vs.xyz);

  vec4 mv = modelViewMatrix * vec4(ps.xyz, 1.0);
  gl_Position = projectionMatrix * mv;

  float life = 7.0 + hash11(seed * 131.7) * 7.0;
  float ageN = ps.w / life;
  vAlpha = smoothstep(0.0, 0.12, ageN) * smoothstep(1.0, 0.8, ageN);

  float t = fract(uHue + seed * 0.42 + speed * 0.03);
  vColor = palette(t) * (0.035 + b * 0.42 + speed * 0.035) * uGlow;

  float dist = max(-mv.z, 1.0);
  gl_PointSize = clamp(uSize * uPixelRatio * (0.5 + b * 1.7) * (42.0 / dist), 0.5, 26.0);
}
`;

const RENDER_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = exp(-r2 * 10.0) * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}
`;

/** Curl-noise particle cloud driven entirely on the GPU. */
export class NebulaScene extends BaseScene {
  readonly id = 'nebula';
  readonly title = 'Nebula';
  readonly blurb = '100k GPU particles · each one tuned to a frequency band';
  override readonly post: Partial<PostParams> = {
    bloom: 0.8,
    threshold: 0.42,
    persistence: 0.4,
    trailZoom: 0.9985,
    trailSpin: 0.0009,
    aberration: 0.3,
    exposure: 1.0,
  };

  private velocity!: SimBuffer;
  private positions!: SimBuffer;
  private points!: Points;
  private material!: ShaderMaterial;
  private cam!: PerspectiveCamera;

  private orbit = 0;
  private pulse = 0;
  private dolly = 0;
  private readonly target = new Vector3();

  protected build(): void {
    const { renderer, quality } = this.ctx;
    const size = quality > 0.85 ? 320 : quality > 0.6 ? 256 : 176;
    const count = size * size;
    const radius = 12;

    const posSeed = new Float32Array(count * 4);
    const velSeed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const seed = Math.random();
      // Uniform direction on the sphere.
      const u = Math.random() * 2 - 1;
      const phi = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const r = radius * (0.22 + seed * 1.0);
      posSeed[i * 4 + 0] = s * Math.cos(phi) * r;
      posSeed[i * 4 + 1] = u * r * 0.25;
      posSeed[i * 4 + 2] = s * Math.sin(phi) * r;
      posSeed[i * 4 + 3] = Math.random() * 7;
      velSeed[i * 4 + 0] = (Math.random() - 0.5) * 0.4;
      velSeed[i * 4 + 1] = (Math.random() - 0.5) * 0.4;
      velSeed[i * 4 + 2] = (Math.random() - 0.5) * 0.4;
      velSeed[i * 4 + 3] = seed;
    }

    this.velocity = new SimBuffer(renderer, size, velSeed, VELOCITY_SHADER, {
      tPos: { value: null },
      uAudio: { value: this.ctx.audio },
      uDt: { value: 0.016 },
      uTime: { value: 0 },
      uFlow: { value: 2.2 },
      uSwirl: { value: 0.35 },
      uPulse: { value: 0 },
      uRadius: { value: radius },
      uDamp: { value: 1.5 },
      uFlatten: { value: 2.4 },
    });

    this.positions = new SimBuffer(renderer, size, posSeed, POSITION_SHADER, {
      tVel: { value: null },
      uAudio: { value: this.ctx.audio },
      uDt: { value: 0.016 },
      uTime: { value: 0 },
      uRadius: { value: radius },
    });

    // The "position" attribute carries the simulation lookup coordinate.
    const refs = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      refs[i * 3 + 0] = ((i % size) + 0.5) / size;
      refs[i * 3 + 1] = (Math.floor(i / size) + 0.5) / size;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(refs, 3));

    this.material = new ShaderMaterial({
      vertexShader: RENDER_VERT,
      fragmentShader: RENDER_FRAG,
      uniforms: {
        tPos: { value: this.positions.texture },
        tVel: { value: this.velocity.texture },
        uAudio: { value: this.ctx.audio },
        uSize: { value: 1.7 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uHue: { value: 0 },
        uGlow: { value: 1 },
        ...this.ctx.palette,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.points = new Points(geometry, this.material);
    this.points.frustumCulled = false;

    this.scene = new Scene();
    this.scene.add(this.points);

    this.cam = new PerspectiveCamera(52, 1, 0.1, 300);
    this.cam.position.set(0, 5, 40);
    this.camera = this.cam;
  }

  resize(width: number, height: number): void {
    this.cam.aspect = width / height;
    this.cam.updateProjectionMatrix();
    this.material.uniforms.uPixelRatio.value = this.ctx.renderer.getPixelRatio();
  }

  update(dt: number, f: Features): void {
    const step = Math.min(dt, 1 / 30);

    this.pulse = Math.max(this.pulse * Math.exp(-step * 5.5), f.onset ? 28 + f.bass * 42 : 0);

    const v = this.velocity.uniforms;
    v.tPos.value = this.positions.texture;
    v.uDt.value = step;
    v.uTime.value = f.time;
    v.uFlow.value = 1.1 + f.mid * 3.4 + f.flux * 2;
    v.uSwirl.value = 0.16 + f.high * 0.34;
    v.uPulse.value = this.pulse;
    v.uDamp.value = 2.3 - f.level * 0.7;
    // Bright, airy passages lift the disc into a sphere and back again.
    v.uFlatten.value = 3.2 - f.air * 2.2 - f.beat * 0.6;

    const p = this.positions.uniforms;
    p.tVel.value = this.velocity.texture;
    p.uDt.value = step;
    p.uTime.value = f.time;

    this.velocity.step(this.ctx.renderer);
    this.positions.step(this.ctx.renderer);

    this.material.uniforms.tPos.value = this.positions.texture;
    this.material.uniforms.tVel.value = this.velocity.texture;
    this.material.uniforms.uHue.value = f.hue;
    this.material.uniforms.uSize.value = 1.15 + f.level * 0.8;
    this.material.uniforms.uGlow.value = 0.75 + f.level * 0.7;

    // Camera: a slow orbit that speeds up with energy, plus a bass-driven dolly.
    this.orbit += step * (0.05 + f.level * 0.1);
    this.dolly += (f.bass * 5 + f.sub * 4 - this.dolly) * Math.min(1, step * 4);
    const radius = 48 - this.dolly + Math.sin(f.time * 0.13) * 4.5;
    // Swing between a rim-on and an overhead read of the disc.
    const tilt = 0.22 + 0.5 * (0.5 + 0.5 * Math.sin(f.time * 0.055));
    this.cam.position.set(
      Math.cos(this.orbit) * radius * Math.cos(tilt),
      radius * Math.sin(tilt) * 0.85 + f.high * 3,
      Math.sin(this.orbit) * radius * Math.cos(tilt),
    );
    this.target.set(0, Math.sin(f.time * 0.07) * 1.2, 0);
    this.cam.lookAt(this.target);
    this.cam.fov = 50 + f.level * 6 + f.beat * 2.5;
    this.cam.updateProjectionMatrix();
  }

  override render(renderer: WebGLRenderer, target: import('three').WebGLRenderTarget): void {
    renderer.setRenderTarget(target);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.cam);
  }

  override dispose(): void {
    this.velocity.dispose();
    this.positions.dispose();
    super.dispose();
  }
}
