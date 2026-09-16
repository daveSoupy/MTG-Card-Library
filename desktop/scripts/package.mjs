#!/usr/bin/env node
// `npm run desktop:package` at the root: the whole pipeline, in order.
//
//   node scripts/package.mjs [--mac] [--win]        (default: both on a Mac,
//                                                    Windows only on Windows)
//
//   1. fetch-node.mjs      the bundled Node for each target (cached in vendor/)
//   2. stage.mjs           the server tree per target (needs `npm run build`)
//   3. tsc                 the shell
//   4. gate, staged        check-sqlite.mjs on the bundled Node against the
//                          staged tree, for the target this machine can run
//   5. electron-builder    .dmg + .zip (mac arm64), NSIS installer (win x64)
//   6. gate, packaged      check-packaged.mjs on what electron-builder produced
//
// A failed gate fails the package: a build whose SQLite lacks FTS5 must
// never reach a user, and it is cheap to ask twice.

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { fetchNode } from './fetch-node.mjs';
import { stage, stagedDir } from './stage.mjs';
import { checkPackaged } from './check-packaged.mjs';

const here = new URL('.', import.meta.url).pathname;
const desktopDir = join(here, '..');
const rootDir = join(desktopDir, '..');

const args = process.argv.slice(2);
const wantMac = args.includes('--mac') || (!args.includes('--win') && process.platform === 'darwin');
const wantWin = args.includes('--win') || !args.includes('--mac');
if (wantMac && process.platform !== 'darwin') throw new Error('the macOS build needs a Mac');

const targets = [];
if (wantMac) targets.push('darwin-arm64');
if (wantWin) targets.push('win32-x64');
const host = `${process.platform}-${process.arch}`;

const step = (title) => console.log(`\n=== ${title} ===`);
const run = (file, argv, options = {}) =>
  execFileSync(file, argv, { stdio: 'inherit', cwd: desktopDir, ...options });

step('1. bundled Node');
for (const target of targets) await fetchNode(target);

step('2. stage the server tree');
stage(targets);

step('3. compile the shell');
run(process.execPath, [join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json']);

step('4. gate: check-sqlite.mjs on the staged tree');
if (targets.includes(host)) {
  const node = join(desktopDir, 'vendor', 'node', host, process.platform === 'win32' ? 'node.exe' : 'node');
  run(node, [join(stagedDir(host), 'server', 'scripts', 'check-sqlite.mjs')]);
} else {
  console.log(`(no ${host} target in this build; the packaged gate checks layout and binary formats)`);
}

step('5. electron-builder');
const builderArgs = [];
if (wantMac) builderArgs.push('--mac');
if (wantWin) builderArgs.push('--win');
run(process.execPath, [join(rootDir, 'node_modules', 'electron-builder', 'cli.js'), ...builderArgs, '--publish', 'never']);

step('6. gate: the packaged app');
let failures = 0;
for (const target of targets) failures += checkPackaged(target);
if (failures > 0) {
  console.error(`\n${failures} packaged app check(s) failed — do not ship out/.`);
  process.exit(1);
}

step('artifacts');
const out = join(desktopDir, 'out');
for (const name of readdirSync(out)) {
  const path = join(out, name);
  const stats = statSync(path);
  if (stats.isFile() && /\.(dmg|zip|exe)$/.test(name)) console.log(`  ${name}  ${(stats.size / 1024 / 1024).toFixed(0)} MB`);
}
console.log('\nUnsigned until Phase 34: a downloaded Mac build needs `xattr -d com.apple.quarantine`; Windows shows SmartScreen (More info → Run anyway).');
