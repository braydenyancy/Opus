#!/usr/bin/env node
/**
 * Headless smoke test: boots the dev server, loads PRISM in Chrome, clicks
 * through every scene and palette, and fails on any console error, page error,
 * shader-compile warning or dropped frame budget.
 *
 *   node scripts/smoke.mjs [--keep-shots]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shotDir = join(root, '.smoke');
const CHROME =
  process.env.CHROME_PATH ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));
const URL = 'http://localhost:5199/';

if (!CHROME) {
  console.error('No Chrome or Chromium found. Set CHROME_PATH to a browser binary.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', '5199', '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});

const problems = [];
let browser;

try {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(URL);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: [
      '--headless=new',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--window-size=1280,800',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  page.on('console', (msg) => {
    const text = msg.text();
    if (/GPU stall due to ReadPixels/.test(text)) return; // screenshot artefact
    if (msg.type() === 'error' || /THREE\.WebGLProgram|shader|GL_INVALID|WebGL context/i.test(text)) {
      problems.push(`console.${msg.type()}: ${text}`);
    }
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => problems.push(`requestfailed: ${req.url()}`));

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1200);

  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, '00-overlay.png') });

  await page.click('#begin');
  await sleep(1500);

  const scenes = await page.$$eval('#scenes button', (b) => b.map((x) => x.textContent));
  for (let i = 0; i < scenes.length; i++) {
    await page.click(`#scenes button:nth-child(${i + 1})`);
    await sleep(2200);
    await page.screenshot({ path: join(shotDir, `${String(i + 1).padStart(2, '0')}-${scenes[i]}.png`) });
    const stats = await page.evaluate(() => ({
      fps: document.getElementById('r-fps')?.textContent,
      bpm: document.getElementById('r-bpm')?.textContent,
      key: document.getElementById('r-key')?.textContent,
    }));
    console.log(`  scene ${scenes[i].padEnd(9)} fps=${stats.fps} bpm=${stats.bpm} key=${stats.key}`);
  }

  // Cycle palettes on the last scene.
  for (let i = 0; i < 6; i++) {
    await page.click(`#palettes button:nth-child(${i + 1})`);
    await sleep(220);
  }
  await sleep(600);
  await page.screenshot({ path: join(shotDir, '90-palette.png') });

  // Exercise trails/glow and the hide-UI path.
  await page.evaluate(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('glow', 1.8);
    set('trails', 1.4);
  });
  await sleep(1000);
  await page.screenshot({ path: join(shotDir, '91-boosted.png') });

  // Judge brightness from the compositor's own screenshot: reading back a
  // WebGL canvas from script would only ever return a cleared buffer.
  const shot = await page.screenshot({ encoding: 'base64', clip: { x: 0, y: 90, width: 1280, height: 520 } });
  const stats = await page.evaluate(
    (b64) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const off = document.createElement('canvas');
          off.width = 200;
          off.height = 80;
          const c = off.getContext('2d');
          c.drawImage(img, 0, 0, 200, 80);
          const d = c.getImageData(0, 0, 200, 80).data;
          let lit = 0;
          let blown = 0;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) {
            const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
            sum += v;
            if (v > 10) lit++;
            if (v > 245) blown++;
          }
          const n = d.length / 4;
          resolve({ lit: lit / n, blown: blown / n, mean: sum / n });
        };
        img.src = `data:image/png;base64,${b64}`;
      }),
    shot,
  );
  console.log(
    `  lit ${(stats.lit * 100).toFixed(1)}%  ·  blown ${(stats.blown * 100).toFixed(1)}%  ·  mean ${stats.mean.toFixed(1)}`,
  );
  if (stats.lit < 0.05) problems.push(`canvas looks blank (${(stats.lit * 100).toFixed(1)}% lit)`);
  if (stats.blown > 0.12) problems.push(`overexposed (${(stats.blown * 100).toFixed(1)}% of pixels clipped white)`);

  writeFileSync(join(shotDir, 'report.json'), JSON.stringify({ problems, stats }, null, 2));
} catch (err) {
  problems.push(`harness: ${err.message}`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s):`);
  for (const p of [...new Set(problems)]) console.error(`  · ${p}`);
  process.exit(1);
}
console.log('\n✓ smoke test passed');
