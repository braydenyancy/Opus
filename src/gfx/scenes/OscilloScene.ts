import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Line,
  LineLoop,
  Mesh,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector2,
} from 'three';
import type { Features } from '../../audio/Analysis';
import { AUDIO_TEX, HASH, PALETTE, SCREEN_VERT } from '../glsl';
import { BaseScene } from '../Scene';
import type { PostParams } from '../Post';

const POINTS = 1024;
const R0 = 0.29;

const BACKDROP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uHue;
uniform float uTime;
uniform float uLevel;
uniform float uBeat;
uniform float uBarPhase;
${HASH}
${AUDIO_TEX}
${PALETTE}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float r = length(p);

  // Bass sits at six o'clock and sweeps up both sides to treble at the top,
  // so the ring stays symmetric about the vertical axis.
  float t = abs(atan(p.x, -p.y)) / 3.14159265359;
  float cells = 64.0;
  float idx = (floor(t * cells) + 0.5) / cells;
  float s = band(idx);
  float pk = peak(idx);
  float gap = smoothstep(0.5, 0.34, abs(fract(t * cells) - 0.5));

  float inner = ${R0.toFixed(3)};
  float outer = inner + 0.012 + s * 0.19;
  float bar = step(inner, r) * smoothstep(0.004, 0.0, r - outer) * gap;
  float peakRing = smoothstep(0.004, 0.0, abs(r - (inner + 0.012 + pk * 0.19))) * gap;

  vec3 c = palette(fract(uHue + t * 0.5));
  vec3 col = c * bar * (0.06 + s * 0.55);
  col += c * peakRing * 0.35;

  // Faint measurement rings and a beat-locked sweep hand.
  float rings = 0.0;
  for (int i = 1; i <= 3; i++) {
    float rr = inner * (0.34 + float(i) * 0.22);
    rings += smoothstep(0.0016, 0.0, abs(r - rr));
  }
  col += vec3(0.30, 0.36, 0.44) * rings * 0.12;

  float a = atan(p.y, p.x) / 6.28318530718 + 0.5;
  float sweep = smoothstep(0.035, 0.0, abs(fract(a - uBarPhase + 0.5) - 0.5));
  col += c * sweep * 0.05 * step(r, inner) * smoothstep(0.0, inner, r);

  // A breath of colour behind the trace, never a hot spot in the middle.
  col += c * smoothstep(inner, inner * 0.25, r) * (0.010 + uBeat * 0.022 + uLevel * 0.014);
  col += vec3(0.010, 0.012, 0.019) * exp(-r * 1.6);

  gl_FragColor = vec4(col, 1.0);
}
`;

const LINE_VERT = /* glsl */ `
precision highp float;
attribute float aT;
uniform float uHue;
uniform float uShift;
varying vec3 vColor;
${PALETTE}
void main() {
  vColor = palette(fract(uHue + aT * 0.35 + uShift));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const LINE_FRAG = /* glsl */ `
precision highp float;
uniform float uIntensity;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor * uIntensity, 1.0);
}
`;

/** Phosphor oscilloscope: a radial spectrum ring around a live XY trace. */
export class OscilloScene extends BaseScene {
  readonly id = 'oscillo';
  readonly title = 'Oscillo';
  readonly blurb = 'phosphor scope · radial spectrum, waveform ring, triggered trace';
  override readonly post: Partial<PostParams> = {
    bloom: 0.7,
    threshold: 0.42,
    persistence: 0.76,
    trailZoom: 1.0,
    trailSpin: 0.0,
    aberration: 0.15,
    grain: 0.02,
    exposure: 1.0,
    vignette: 0.6,
  };

  private cam!: OrthographicCamera;
  private backdrop!: ShaderMaterial;
  private ringMat!: ShaderMaterial;
  private xyMat!: ShaderMaterial;
  private ringPos!: Float32Array;
  private xyPos!: Float32Array;
  private ringAttr!: BufferAttribute;
  private xyAttr!: BufferAttribute;
  private spin = 0;
  private traceScale = R0 * 0.6;

  protected build(): void {
    this.scene = new Scene();
    this.cam = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
    this.cam.position.z = 1;
    this.camera = this.cam;

    // --- backdrop (drawn with a screen-space triangle, ignores the camera)
    this.backdrop = new ShaderMaterial({
      vertexShader: SCREEN_VERT,
      fragmentShader: BACKDROP_FRAG,
      uniforms: {
        uRes: { value: new Vector2(1, 1) },
        uAudio: { value: this.ctx.audio },
        uHue: { value: 0 },
        uTime: { value: 0 },
        uLevel: { value: 0 },
        uBeat: { value: 0 },
        uBarPhase: { value: 0 },
        ...this.ctx.palette,
      },
      depthTest: false,
      depthWrite: false,
    });
    const tri = new BufferGeometry();
    tri.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    tri.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const bg = new Mesh(tri, this.backdrop);
    bg.frustumCulled = false;
    bg.renderOrder = -1;
    this.scene.add(bg);

    // --- circular waveform
    this.ringPos = new Float32Array(POINTS * 3);
    this.ringAttr = new BufferAttribute(this.ringPos, 3);
    this.ringAttr.setUsage(DynamicDrawUsage);
    const ringGeo = new BufferGeometry();
    ringGeo.setAttribute('position', this.ringAttr);
    ringGeo.setAttribute('aT', new BufferAttribute(this.ramp(POINTS), 1));
    this.ringMat = this.lineMaterial(0.0, 1.5);
    const ring = new LineLoop(ringGeo, this.ringMat);
    ring.frustumCulled = false;
    this.scene.add(ring);

    // --- inner Lissajous (x = s[i], y = s[i + quarter period])
    this.xyPos = new Float32Array(POINTS * 3);
    this.xyAttr = new BufferAttribute(this.xyPos, 3);
    this.xyAttr.setUsage(DynamicDrawUsage);
    const xyGeo = new BufferGeometry();
    xyGeo.setAttribute('position', this.xyAttr);
    xyGeo.setAttribute('aT', new BufferAttribute(this.ramp(POINTS), 1));
    this.xyMat = this.lineMaterial(0.45, 0.85);
    const xy = new Line(xyGeo, this.xyMat);
    xy.frustumCulled = false;
    this.scene.add(xy);
  }

  private ramp(n: number): Float32Array {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = i / (n - 1);
    return a;
  }

  private lineMaterial(shift: number, intensity: number): ShaderMaterial {
    return new ShaderMaterial({
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: {
        uHue: { value: 0 },
        uShift: { value: shift },
        uIntensity: { value: intensity },
        ...this.ctx.palette,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
  }

  resize(width: number, height: number): void {
    const aspect = width / height;
    this.cam.left = -aspect;
    this.cam.right = aspect;
    this.cam.top = 1;
    this.cam.bottom = -1;
    this.cam.updateProjectionMatrix();
    (this.backdrop.uniforms.uRes.value as Vector2).set(width, height);
  }

  update(dt: number, f: Features): void {
    const wave = f.wave;
    const n = wave.length;
    this.spin += dt * (0.05 + f.high * 0.35);

    const amp = 0.11 + f.level * 0.17;
    const wobble = 1 + f.beat * 0.06;

    for (let i = 0; i < POINTS; i++) {
      const u = i / POINTS;
      const s = wave[Math.floor(u * n)] ?? 0;
      const angle = u * Math.PI * 2 + this.spin;
      const radius = (R0 + s * amp) * wobble;
      this.ringPos[i * 3 + 0] = Math.cos(angle) * radius;
      this.ringPos[i * 3 + 1] = Math.sin(angle) * radius;
      this.ringPos[i * 3 + 2] = 0;
    }
    this.ringAttr.needsUpdate = true;

    // Inside the ring, a straight scope sweep. It is triggered on a rising
    // zero crossing near the start of the buffer, which is what stops the
    // waveform from sliding sideways frame to frame.
    let trigger = 0;
    const searchLimit = Math.min(n >> 1, Math.round(f.sampleRate / Math.max(40, f.dominantHz)) * 2);
    for (let i = 1; i < searchLimit; i++) {
      if (wave[i - 1] <= 0 && wave[i] > 0) {
        trigger = i;
        break;
      }
    }
    let peak = 0.03;
    for (let i = 0; i < n; i += 4) peak = Math.max(peak, Math.abs(wave[i]));
    // Normalise to the current peak so the trace always fills the inner disc.
    this.traceScale += (Math.min(R0 * 0.62, (R0 * 0.5) / peak) - this.traceScale) * Math.min(1, dt * 2.5);

    const span = R0 * 0.78;
    const window = n - trigger - 1;
    for (let i = 0; i < POINTS; i++) {
      const u = i / (POINTS - 1);
      const s = wave[trigger + Math.floor(u * window)] ?? 0;
      // Taper the ends so the trace fades into the disc instead of stopping dead.
      const taper = Math.min(1, Math.sin(u * Math.PI) * 3);
      this.xyPos[i * 3 + 0] = (u * 2 - 1) * span;
      this.xyPos[i * 3 + 1] = s * this.traceScale * taper;
      this.xyPos[i * 3 + 2] = 0;
    }
    this.xyAttr.needsUpdate = true;

    this.backdrop.uniforms.uHue.value = f.hue;
    this.backdrop.uniforms.uTime.value = f.time;
    this.backdrop.uniforms.uLevel.value = f.level;
    this.backdrop.uniforms.uBeat.value = f.beat;
    this.backdrop.uniforms.uBarPhase.value = f.barPhase;
    this.ringMat.uniforms.uHue.value = f.hue;
    this.ringMat.uniforms.uIntensity.value = 0.45 + f.level * 0.7;
    this.xyMat.uniforms.uHue.value = f.hue;
    this.xyMat.uniforms.uIntensity.value = 0.55 + f.mid * 0.8;
  }
}
