import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  FloatType,
  Mesh,
  NearestFilter,
  PerspectiveCamera,
  RedFormat,
  Scene,
  ShaderMaterial,
  Vector3,
} from 'three';
import { NUM_BANDS, type Features } from '../../audio/Analysis';
import { PALETTE } from '../glsl';
import { BaseScene } from '../Scene';
import type { PostParams } from '../Post';

const COLS = NUM_BANDS;
const ROWS = 220;
const SPAN_X = 46;
const SPAN_Z = 78;
const ROW_HZ = 60; // history rows per second, independent of frame rate

const VERT = /* glsl */ `
precision highp float;
uniform sampler2D tHistory;
uniform float uHead;
uniform float uRows;
uniform float uAmp;
uniform float uMirror;
uniform float uSpread;
varying float vH;
varying vec2 vGrid;
void main() {
  float row = mod(uHead + uv.y * (uRows - 1.0), uRows);
  float h = texture2D(tHistory, vec2(uv.x, (row + 0.5) / uRows)).r;
  vH = h;
  vGrid = uv;
  vec3 p = position;
  p.y = pow(max(h, 0.0), 1.22) * uAmp;
  p.x *= 1.0 + uv.y * uSpread;
  p.y -= uv.y * uv.y * 3.0;
  p.y *= uMirror;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uHue;
uniform float uTime;
uniform float uDim;
varying float vH;
varying vec2 vGrid;
${PALETTE}
void main() {
  float fade = exp(-vGrid.y * 1.9);
  vec3 c = palette(fract(uHue + vH * 0.36 + vGrid.x * 0.18));
  float contour = smoothstep(0.86, 1.0, fract(vH * 15.0 - uTime * 0.6));
  float gridx = smoothstep(0.92, 1.0, abs(fract(vGrid.x * 64.0) * 2.0 - 1.0));
  float gridz = smoothstep(0.94, 1.0, abs(fract(vGrid.y * 55.0) * 2.0 - 1.0));
  vec3 col = c * (0.02 + vH * vH * 1.05)
           + c * contour * 0.22
           + c * (gridx * 0.07 + gridz * 0.045);
  gl_FragColor = vec4(col * fade * uDim, 1.0);
}
`;

/** A scrolling spectrogram rendered as terrain — the track's own topography. */
export class TerrainScene extends BaseScene {
  readonly id = 'terrain';
  readonly title = 'Terrain';
  readonly blurb = 'a scrolling spectrogram, extruded into landscape';
  override readonly post: Partial<PostParams> = {
    bloom: 0.7,
    threshold: 0.5,
    persistence: 0,
    aberration: 0.2,
    exposure: 1.0,
    vignette: 0.7,
  };

  private data!: Float32Array;
  private texture!: DataTexture;
  private surface!: ShaderMaterial;
  private mirror!: ShaderMaterial;
  private cam!: PerspectiveCamera;
  private head = 0;
  private accumulator = 0;
  private readonly lookAt = new Vector3();

  protected build(): void {
    this.data = new Float32Array(COLS * ROWS);
    this.texture = new DataTexture(this.data, COLS, ROWS, RedFormat, FloatType);
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.needsUpdate = true;

    const geometry = this.buildGrid();

    const uniforms = () => ({
      tHistory: { value: this.texture },
      uHead: { value: 0 },
      uRows: { value: ROWS },
      uAmp: { value: 10 },
      uMirror: { value: 1 },
      uSpread: { value: 0.55 },
      uHue: { value: 0 },
      uTime: { value: 0 },
      uDim: { value: 1 },
      ...this.ctx.palette,
    });

    this.surface = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: uniforms(),
      side: DoubleSide,
    });

    this.mirror = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...uniforms(), uMirror: { value: -1 }, uDim: { value: 0.32 } },
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.scene = new Scene();
    this.scene.add(new Mesh(geometry, this.surface));
    this.scene.add(new Mesh(geometry, this.mirror));

    this.cam = new PerspectiveCamera(55, 1, 0.1, 400);
    this.camera = this.cam;
  }

  private buildGrid(): BufferGeometry {
    const positions = new Float32Array(COLS * ROWS * 3);
    const uvs = new Float32Array(COLS * ROWS * 2);
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const k = j * COLS + i;
        positions[k * 3 + 0] = (i / (COLS - 1) - 0.5) * SPAN_X;
        positions[k * 3 + 1] = 0;
        positions[k * 3 + 2] = -(j / (ROWS - 1)) * SPAN_Z;
        // Sample exactly at texel centres on the frequency axis.
        uvs[k * 2 + 0] = (i + 0.5) / COLS;
        uvs[k * 2 + 1] = j / (ROWS - 1);
      }
    }
    const indices = new Uint32Array((COLS - 1) * (ROWS - 1) * 6);
    let n = 0;
    for (let j = 0; j < ROWS - 1; j++) {
      for (let i = 0; i < COLS - 1; i++) {
        const a = j * COLS + i;
        const b = a + 1;
        const c = a + COLS;
        const d = c + 1;
        indices[n++] = a;
        indices[n++] = c;
        indices[n++] = b;
        indices[n++] = b;
        indices[n++] = c;
        indices[n++] = d;
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('uv', new BufferAttribute(uvs, 2));
    g.setIndex(new BufferAttribute(indices, 1));
    g.computeBoundingSphere();
    return g;
  }

  resize(width: number, height: number): void {
    this.cam.aspect = width / height;
    this.cam.updateProjectionMatrix();
  }

  update(dt: number, f: Features): void {
    // Push history rows on a fixed clock so the scroll speed never depends on
    // how fast the GPU happens to be.
    this.accumulator += dt;
    let pushed = false;
    let guard = 0;
    while (this.accumulator >= 1 / ROW_HZ && guard++ < 4) {
      this.accumulator -= 1 / ROW_HZ;
      this.head = (this.head - 1 + ROWS) % ROWS;
      this.data.set(f.bands, this.head * COLS);
      pushed = true;
    }
    if (pushed) this.texture.needsUpdate = true;

    for (const m of [this.surface, this.mirror]) {
      m.uniforms.uHead.value = this.head;
      m.uniforms.uHue.value = f.hue;
      m.uniforms.uTime.value = f.time;
      m.uniforms.uAmp.value = 6.5 + f.level * 3.5 + f.beat * 0.8;
      m.uniforms.uSpread.value = 0.5 + f.lowMid * 0.3;
    }

    const sway = Math.sin(f.time * 0.19) * 3.4;
    this.cam.position.set(sway, 7.6 + f.bass * 1.8 + Math.sin(f.time * 0.11) * 1.2, 19 - f.level * 2.5);
    this.lookAt.set(sway * 0.25, 3.6 + f.high * 1.2, -40);
    this.cam.lookAt(this.lookAt);
    this.cam.rotation.z = Math.sin(f.time * 0.13) * 0.03;
    this.cam.fov = 52 + f.level * 4;
    this.cam.updateProjectionMatrix();
  }

  override dispose(): void {
    this.texture.dispose();
    super.dispose();
  }
}
