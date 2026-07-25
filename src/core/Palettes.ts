import { Vector3 } from 'three';

export interface Palette {
  name: string;
  /** Cosine-gradient coefficients: colour(t) = a + b·cos(2π(c·t + d)). */
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  d: [number, number, number];
  /** UI accent, sampled from the middle of the ramp. */
  accent: string;
}

export const PALETTES: Palette[] = [
  {
    name: 'Prism',
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.33, 0.67],
    accent: '#4fd6ff',
  },
  {
    name: 'Ember',
    a: [0.78, 0.48, 0.38],
    b: [0.22, 0.42, 0.22],
    c: [2.0, 1.0, 1.0],
    d: [0.0, 0.25, 0.25],
    accent: '#ff9455',
  },
  {
    name: 'Cyanotype',
    a: [0.42, 0.5, 0.56],
    b: [0.48, 0.48, 0.5],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.1, 0.2],
    accent: '#63b8ff',
  },
  {
    name: 'Orchid',
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [2.0, 1.0, 0.0],
    d: [0.5, 0.2, 0.25],
    accent: '#e372ff',
  },
  {
    name: 'Lumen',
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 1.0, 0.5],
    d: [0.8, 0.9, 0.3],
    accent: '#7bf1a8',
  },
  {
    name: 'Graphite',
    a: [0.56, 0.58, 0.63],
    b: [0.38, 0.38, 0.4],
    c: [1.0, 1.0, 1.0],
    d: [0.12, 0.18, 0.26],
    accent: '#c8d2e0',
  },
];

/** Uniform block shared by every shader that uses `palette(t)`. */
export interface PaletteUniforms {
  uPalA: { value: Vector3 };
  uPalB: { value: Vector3 };
  uPalC: { value: Vector3 };
  uPalD: { value: Vector3 };
}

export function makePaletteUniforms(): PaletteUniforms {
  return {
    uPalA: { value: new Vector3() },
    uPalB: { value: new Vector3() },
    uPalC: { value: new Vector3() },
    uPalD: { value: new Vector3() },
  };
}

/** Eased crossfade between palettes so switching never pops. */
export function applyPalette(u: PaletteUniforms, from: Palette, to: Palette, t: number): void {
  const k = t * t * (3 - 2 * t);
  const mix = (x: [number, number, number], y: [number, number, number], out: Vector3) =>
    out.set(x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k);
  mix(from.a, to.a, u.uPalA.value);
  mix(from.b, to.b, u.uPalB.value);
  mix(from.c, to.c, u.uPalC.value);
  mix(from.d, to.d, u.uPalD.value);
}
