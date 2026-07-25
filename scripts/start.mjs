#!/usr/bin/env node
/**
 * One-command launcher for PRISM.
 *
 *   npm start
 *
 * Installs dependencies if they are missing, then boots the dev server and
 * opens a browser. Deliberately dependency-free so it runs before `npm install`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

console.log(`\n  ${cyan('PRISM')} ${dim('· audio-reactive visual instrument')}\n`);

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`  Node 18+ is required (found ${process.versions.node}).\n`);
  process.exit(1);
}

if (!existsSync(join(root, 'node_modules', 'three'))) {
  console.log(dim('  Installing dependencies (first run only)…\n'));
  const install = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
  console.log('');
}

const args = ['--open', ...process.argv.slice(2)];
const vite = spawn(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite'), args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

vite.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => vite.kill(sig));
