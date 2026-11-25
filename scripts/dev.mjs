#!/usr/bin/env node
// `npm run dev` / `npm run demo` — the whole app on one command, no hardware.
//
//   1. starts the label server (Server/index.js) in DEMO_MODE on :5180, with
//      its SQLite database in .demo_data/ (never the production Data/ folder);
//   2. seeds that database with synthetic products and batches the first time
//      (scripts/demo_seed.mjs, which goes through the real HTTP routes);
//   3. starts Vite on :5173, which proxies /api to the server.
//
// Server-side printing renders the BUILT app (dist/) in headless Chrome, so
// the first run builds it once if dist/ is missing.
//
// `npm run demo:reset` deletes .demo_data/ first, so the demo starts clean.
// Ctrl+C stops both processes.

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedDemo, waitForServer } from './demo_seed.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.demo_data');
const port = process.env.LABEL_PORT || '5180';

if (process.argv.includes('--reset')) {
  rmSync(dataDir, { recursive: true, force: true });
  console.log('Demo data reset.');
}

const env = {
  ...process.env,
  DEMO_MODE: '1',
  VITE_DEMO_MODE: '1',
  LABEL_PORT: port,
  LABEL_DATA_DIR: process.env.LABEL_DATA_DIR || dataDir,
};

const children = [];
function run(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  children.push(child);
  child.on('exit', (code) => {
    if (code && code !== 0) shutdown(code);
  });
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.log('Building dist/ once for the headless print render...');
  await new Promise((resolve, reject) => {
    const build = spawn('npx', ['vite', 'build'], {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    build.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('vite build failed')),
    );
  });
}

run('node', ['Server/index.js']);
const base = `http://localhost:${port}`;
await waitForServer(base);
await seedDemo(base);
run('npx', ['vite']);
