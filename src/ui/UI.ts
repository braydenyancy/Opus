import type { Features } from '../audio/Analysis';
import type { SourceKind } from '../audio/AudioEngine';
import { PALETTES, type Palette } from '../core/Palettes';
import { SCENES } from '../gfx/Visualizer';

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export interface UICallbacks {
  playToggle(): void;
  source(kind: SourceKind): void;
  file(file: File): void;
  scene(index: number): void;
  sceneStep(delta: number): void;
  palette(index: number): void;
  paletteStep(): void;
  glow(value: number): void;
  trails(value: number): void;
  auto(on: boolean): void;
  shot(): void;
  seek(fraction: number): void;
  begin(): void;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

/** Evaluate a cosine-gradient palette on the CPU for CSS swatches. */
function sampleCss(p: Palette, t: number): string {
  const ch = (i: number) => {
    const v = p.a[i] + p.b[i] * Math.cos(Math.PI * 2 * (p.c[i] * t + p.d[i]));
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };
  return `rgb(${ch(0)} ${ch(1)} ${ch(2)})`;
}

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export class UI {
  private readonly cb: UICallbacks;

  private readonly overlay = $('overlay');
  private readonly help = $('help');
  private readonly drop = $('drop');
  private readonly toastEl = $('toast');
  private readonly sceneBlurb = $('scene-blurb');
  private readonly trackTitle = $('track-title');
  private readonly timeNow = $('time-now');
  private readonly scrub = $('scrub');
  private readonly scrubFill = $('scrub-fill');
  private readonly sceneBar = $('scenes');
  private readonly paletteBar = $('palettes');
  private readonly sourceBar = $('source');
  private readonly autoBtn = $<HTMLButtonElement>('auto');
  private readonly fileInput = $<HTMLInputElement>('file-input');
  private readonly mini = $<HTMLCanvasElement>('mini');
  private readonly miniCtx: CanvasRenderingContext2D;
  private readonly rBpm = $('r-bpm');
  private readonly rKey = $('r-key');
  private readonly rLevel = $('r-level');
  private readonly rFps = $('r-fps');

  private idleTimer = 0;
  private toastTimer = 0;
  private textClock = 0;
  private scrubbing = false;
  private started = false;

  constructor(cb: UICallbacks) {
    this.cb = cb;
    this.miniCtx = this.mini.getContext('2d')!;
    this.buildScenes();
    this.buildPalettes();
    this.wire();
    this.armIdle();
  }

  // ------------------------------------------------------------ construction

  private buildScenes(): void {
    SCENES.forEach((s, i) => {
      const b = document.createElement('button');
      b.textContent = s.title;
      b.dataset.index = String(i);
      b.title = `${s.title}  ·  key ${i + 1}`;
      if (i === 0) b.classList.add('on');
      b.addEventListener('click', () => this.cb.scene(i));
      this.sceneBar.appendChild(b);
    });
  }

  private buildPalettes(): void {
    PALETTES.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.title = p.name;
      b.setAttribute('aria-label', `Palette ${p.name}`);
      const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => sampleCss(p, t)).join(', ');
      b.style.background = `conic-gradient(from 220deg, ${stops})`;
      if (i === 0) b.classList.add('on');
      b.addEventListener('click', () => this.cb.palette(i));
      this.paletteBar.appendChild(b);
    });
  }

  private wire(): void {
    $('play').addEventListener('click', () => this.cb.playToggle());
    $('begin').addEventListener('click', () => this.begin());
    $('shot').addEventListener('click', () => this.cb.shot());
    $('full').addEventListener('click', () => this.toggleFullscreen());
    this.autoBtn.addEventListener('click', () => {
      const on = !this.autoBtn.classList.contains('on');
      this.autoBtn.classList.toggle('on', on);
      this.cb.auto(on);
      this.toast(on ? 'Auto-cycle on — scenes change every 16 bars' : 'Auto-cycle off');
    });

    this.sourceBar.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.addEventListener('click', () => {
        const kind = b.dataset.src as SourceKind;
        if (kind === 'file') this.fileInput.click();
        else this.cb.source(kind);
      });
    });

    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      if (f) this.cb.file(f);
      this.fileInput.value = '';
    });

    $<HTMLInputElement>('glow').addEventListener('input', (e) =>
      this.cb.glow(Number((e.target as HTMLInputElement).value)),
    );
    $<HTMLInputElement>('trails').addEventListener('input', (e) =>
      this.cb.trails(Number((e.target as HTMLInputElement).value)),
    );

    // --- scrubbing
    const seekFrom = (e: PointerEvent) => {
      const r = this.scrub.getBoundingClientRect();
      this.cb.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
    };
    this.scrub.addEventListener('pointerdown', (e) => {
      this.scrubbing = true;
      this.scrub.setPointerCapture(e.pointerId);
      seekFrom(e);
    });
    this.scrub.addEventListener('pointermove', (e) => this.scrubbing && seekFrom(e));
    this.scrub.addEventListener('pointerup', (e) => {
      this.scrubbing = false;
      this.scrub.releasePointerCapture(e.pointerId);
    });

    // --- drag and drop, anywhere
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (++dragDepth === 1) this.drop.classList.add('over');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (--dragDepth <= 0) {
        dragDepth = 0;
        this.drop.classList.remove('over');
      }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      this.drop.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) this.cb.file(f);
    });

    // --- keyboard
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      if (key === 'Escape') {
        this.help.classList.remove('open');
        return;
      }
      if (!this.started) {
        if (key === 'Enter' || key === ' ') {
          e.preventDefault();
          this.begin();
        }
        return;
      }
      switch (key) {
        case ' ':
          e.preventDefault();
          this.cb.playToggle();
          break;
        case 'ArrowRight':
          this.cb.sceneStep(1);
          break;
        case 'ArrowLeft':
          this.cb.sceneStep(-1);
          break;
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
          this.cb.scene(Number(key) - 1);
          break;
        case 'p':
        case 'P':
          this.cb.paletteStep();
          break;
        case 'a':
        case 'A':
          this.autoBtn.click();
          break;
        case 'o':
        case 'O':
          this.fileInput.click();
          break;
        case 'm':
        case 'M':
          this.cb.source('mic');
          break;
        case 'd':
        case 'D':
          this.cb.source('demo');
          break;
        case 's':
        case 'S':
          this.cb.shot();
          break;
        case 'f':
        case 'F':
          this.toggleFullscreen();
          break;
        case 'h':
        case 'H':
          document.body.classList.toggle('hidden-ui');
          break;
        case '?':
        case '/':
          this.help.classList.toggle('open');
          break;
      }
    });

    // --- idle hiding
    for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const) {
      window.addEventListener(ev, () => this.armIdle(), { passive: true });
    }
  }

  private armIdle(): void {
    document.body.classList.remove('idle');
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => document.body.classList.add('idle'), 3200);
  }

  private begin(): void {
    if (this.started) return;
    this.started = true;
    this.overlay.classList.add('gone');
    this.cb.begin();
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => this.toast('Fullscreen unavailable'));
  }

  // ------------------------------------------------------------------ state

  setPlaying(on: boolean): void {
    document.body.classList.toggle('playing', on);
  }

  setSource(kind: SourceKind, label: string, seekable: boolean): void {
    this.sourceBar.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.src === kind);
    });
    this.trackTitle.textContent = label;
    this.trackTitle.title = label;
    this.scrub.classList.toggle('disabled', !seekable);
    if (!seekable) this.scrubFill.style.width = '0%';
  }

  setScene(index: number, blurb: string): void {
    this.sceneBar.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.index) === index);
    });
    this.sceneBlurb.textContent = blurb;
  }

  setPalette(index: number): void {
    this.paletteBar.querySelectorAll<HTMLButtonElement>('button').forEach((b, i) => {
      b.classList.toggle('on', i === index);
    });
    document.documentElement.style.setProperty('--accent', PALETTES[index].accent);
  }

  setProgress(position: number, duration: number): void {
    this.timeNow.textContent = duration > 0 ? `${fmtTime(position)} / ${fmtTime(duration)}` : fmtTime(position);
    if (duration > 0 && !this.scrubbing) {
      this.scrubFill.style.width = `${Math.min(100, (position / duration) * 100)}%`;
    }
  }

  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2600);
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, f: Features, fps: number): void {
    this.drawMini(f);
    this.textClock += dt;
    if (this.textClock < 0.12) return;
    this.textClock = 0;

    this.rBpm.textContent = f.tempoConfidence > 0.2 ? f.bpm.toFixed(0) : '—';
    this.rFps.textContent = fps.toFixed(0);
    this.rLevel.textContent = `${(20 * Math.log10(Math.max(f.level, 1e-4))).toFixed(0)}`;

    let best = 0;
    for (let i = 1; i < 12; i++) if (f.chroma[i] > f.chroma[best]) best = i;
    this.rKey.textContent = f.silence > 0.7 ? '—' : NOTES[best];
  }

  private drawMini(f: Features): void {
    const c = this.miniCtx;
    const w = this.mini.width;
    const h = this.mini.height;
    c.clearRect(0, 0, w, h);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4fd6ff';
    const bars = 48;
    const gap = 2;
    const bw = (w - gap * (bars - 1)) / bars;
    const stride = f.bands.length / bars;

    c.fillStyle = 'rgba(255,255,255,0.10)';
    for (let i = 0; i < bars; i++) c.fillRect(i * (bw + gap), h - 2, bw, 2);

    c.fillStyle = accent;
    c.shadowColor = accent;
    c.shadowBlur = 6;
    for (let i = 0; i < bars; i++) {
      let v = 0;
      for (let k = 0; k < stride; k++) v = Math.max(v, f.bands[Math.floor(i * stride) + k] ?? 0);
      const bh = Math.max(2, v * (h - 4));
      c.fillRect(i * (bw + gap), h - bh, bw, bh);
    }
    c.shadowBlur = 0;

    c.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < bars; i++) {
      let v = 0;
      for (let k = 0; k < stride; k++) v = Math.max(v, f.peaks[Math.floor(i * stride) + k] ?? 0);
      const y = h - Math.max(2, v * (h - 4));
      c.fillRect(i * (bw + gap), y - 1, bw, 1.5);
    }
  }
}
