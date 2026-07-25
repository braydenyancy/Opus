import './style.css';
import { Analysis } from './audio/Analysis';
import { AudioEngine, type SourceKind } from './audio/AudioEngine';
import { PALETTES } from './core/Palettes';
import { Visualizer } from './gfx/Visualizer';
import { UI } from './ui/UI';

const canvas = document.getElementById('stage') as HTMLCanvasElement;

let engine: AudioEngine;
let analysis: Analysis;
let viz: Visualizer;

try {
  engine = new AudioEngine();
  analysis = new Analysis(engine);
  viz = new Visualizer(canvas);
} catch (err) {
  document.body.innerHTML = `<div style="display:grid;place-items:center;height:100%;font:14px/1.6 system-ui;color:#8b93a3;text-align:center;padding:32px">
    <div><strong style="color:#e9eef7;letter-spacing:.3em">PRISM</strong><br><br>
    This browser could not start WebGL2 or WebAudio.<br>Try a recent Chrome, Edge, Firefox or Safari.<br><br>
    <code style="font-size:12px;opacity:.6">${String(err)}</code></div></div>`;
  throw err;
}

const ui = new UI({
  begin: () => {
    void start();
  },
  playToggle: () => {
    engine.toggle();
    ui.setPlaying(engine.isPlaying);
  },
  source: (kind) => void switchSource(kind),
  file: (file) => void loadFile(file),
  scene: (i) => selectScene(i),
  sceneStep: (d) => selectScene(viz.sceneIndex + d),
  palette: (i) => selectPalette(i),
  paletteStep: () => selectPalette(viz.paletteIndex + 1),
  glow: (v) => (viz.settings.glow = v),
  trails: (v) => (viz.settings.trails = v),
  auto: (on) => (viz.settings.autoCycle = on),
  shot: () => void saveFrame(),
  seek: (fraction) => {
    if (engine.info.duration > 0) engine.seek(fraction * engine.info.duration);
  },
});

// ------------------------------------------------------------------ actions

async function start(): Promise<void> {
  try {
    await engine.useDemo();
    ui.setPlaying(engine.isPlaying);
    ui.setSource('demo', engine.info.label, false);
    ui.toast('Drop an audio file anywhere, or press M for the microphone');
  } catch (err) {
    ui.toast(`Could not start audio: ${String(err)}`);
  }
}

async function switchSource(kind: SourceKind): Promise<void> {
  try {
    if (kind === 'demo') await engine.useDemo();
    else if (kind === 'mic') {
      await engine.useMic();
      ui.toast('Listening — the analyser is now following your input');
    }
    ui.setPlaying(engine.isPlaying);
    ui.setSource(engine.info.kind, engine.info.label, engine.info.duration > 0);
  } catch (err) {
    const message = String(err).includes('NotAllowed')
      ? 'Microphone permission denied'
      : `Could not switch source: ${String(err)}`;
    ui.toast(message);
    ui.setSource(engine.info.kind, engine.info.label, engine.info.duration > 0);
  }
}

async function loadFile(file: File): Promise<void> {
  ui.toast(`Decoding ${file.name}…`);
  try {
    await engine.useFile(file);
    ui.setPlaying(engine.isPlaying);
    ui.setSource('file', engine.info.label, true);
    ui.toast(`Now playing · ${engine.info.label}`);
  } catch {
    ui.toast(`Could not decode ${file.name} — try WAV, MP3, FLAC, OGG or M4A`);
  }
}

function selectScene(index: number): void {
  viz.setScene(index);
  ui.setScene(viz.sceneIndex, viz.sceneBlurb);
}

function selectPalette(index: number): void {
  viz.setPalette(index);
  ui.setPalette(viz.paletteIndex);
  ui.toast(`Palette · ${PALETTES[viz.paletteIndex].name}`);
}

async function saveFrame(): Promise<void> {
  const url = await viz.capture();
  const a = document.createElement('a');
  a.href = url;
  a.download = `prism-${viz.sceneTitle.toLowerCase()}-${Date.now()}.png`;
  a.click();
  ui.toast('Frame saved');
}

// -------------------------------------------------------------------- setup

engine.onEnded = () => {
  ui.setPlaying(false);
  ui.toast('Track finished');
};

ui.setScene(0, viz.sceneBlurb);
ui.setPalette(0);
ui.setSource('demo', engine.info.label, false);

const resize = () => viz.resize();
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);
resize();

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  ui.toast('Graphics context lost — reload to continue');
});

// ------------------------------------------------------------------- render

let last = performance.now();
let autoCycleMark = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(Math.max((now - last) / 1000, 1 / 480), 0.1);
  last = now;

  const f = analysis.update(dt);
  const before = viz.sceneIndex;
  viz.frame(dt, f);
  if (viz.sceneIndex !== before) {
    ui.setScene(viz.sceneIndex, viz.sceneBlurb);
    if (now - autoCycleMark > 1000) {
      autoCycleMark = now;
      ui.toast(`Scene · ${viz.sceneTitle}`);
    }
  }
  ui.update(dt, f, viz.fps);
  ui.setProgress(engine.position, engine.info.duration);
}

requestAnimationFrame(frame);
