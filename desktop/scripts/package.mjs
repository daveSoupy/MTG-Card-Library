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
//   5. electron-builder    .dmg + .zip (mac arm64 and x64), NSIS installer
//                          (win x64); signed and notarised when the
//                          environment allows (electron-builder.yml's header
//                          says what decides)
//   6. gate, packaged      check-packaged.mjs on what electron-builder produced
//
// A failed gate fails the package: a build whose SQLite lacks FTS5 must
// never reach a user, and it is cheap to ask twice. --require-signed and
// --require-notarized pass through to the gate: the release workflow sets
// both, because a release that is not notarised is one nobody else can open.
//
// Publishing is not done here (`--publish never`): the workflow uploads
// out/ with `gh` after the gate, so nothing reaches the release page that
// did not pass. latest-mac.yml / latest.yml are still written to out/.

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchNode } from './fetch-node.mjs';
import { stage, stagedDir } from './stage.mjs';
import { checkPackaged } from './check-packaged.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const desktopDir = join(here, '..');
const rootDir = join(desktopDir, '..');

const args = process.argv.slice(2);
const wantMac = args.includes('--mac') || (!args.includes('--win') && process.platform === 'darwin');
const wantWin = args.includes('--win') || !args.includes('--mac');
if (wantMac && process.platform !== 'darwin') throw new Error('the macOS build needs a Mac');

// Both Mac arches: Electron 44 runs on macOS 13, which Intel Macs from 2017
// on can install, and the build is cross-compiled from whichever Mac this is
// — prebuild-install fetches better-sqlite3 per arch and check-packaged.mjs
// verifies the header, so the only thing that still needs a real Intel Mac is
// launching it.
const targets = [];
if (wantMac) targets.push('darwin-arm64', 'darwin-x64');
if (wantWin) targets.push('win32-x64');
const host = `${process.platform}-${process.arch}`;

const step = (title) => console.log(`\n=== ${title} ===`);
const run = (file, argv, options = {}) =>
  execFileSync(file, argv, { stdio: 'inherit', cwd: desktopDir, ...options });

/**
 * macOS: is `dir` inside a folder a File Provider syncs — iCloud Drive's
 * Desktop & Documents, Dropbox, OneDrive? The provider marks every directory
 * it manages with a `com.apple.fileprovider.*` extended attribute, so any
 * ancestor carrying one is the answer.
 */
function underFileProvider(dir) {
  if (process.platform !== 'darwin') return false;
  for (let d = dir; ; d = dirname(d)) {
    try {
      if (/com\.apple\.file-?provider/.test(execFileSync('xattr', ['-l', d], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))) return true;
    } catch {
      // Unreadable directory; keep climbing.
    }
    if (dirname(d) === d) return false;
  }
}

/**
 * Where electron-builder writes. Normally desktop/out. When the workspace is
 * inside a synced folder, out/ becomes a symlink to a directory outside it,
 * because signing cannot succeed in one: the File Provider re-stamps every
 * .app bundle with com.apple.FinderInfo seconds after anything clears it,
 * and codesign refuses a bundle carrying that ("resource fork, Finder
 * information, or similar detritus not allowed"). Every script keeps using
 * desktop/out; only the bytes move. A `.nosync` suffix does not stop Desktop
 * & Documents sync from stamping, so this is the fix, not that.
 */
function ensureOutDir() {
  const out = join(desktopDir, 'out');
  if (!underFileProvider(desktopDir)) return out;
  const external = join(homedir(), 'Library', 'Caches', 'mtg-library-desktop', 'out');
  mkdirSync(external, { recursive: true });
  let existing = null;
  try {
    existing = lstatSync(out);
  } catch {
    // No out/ yet.
  }
  if (existing?.isSymbolicLink()) {
    if (readlinkSync(out) === external) return out;
    unlinkSync(out);
  } else if (existing) {
    rmSync(out, { recursive: true, force: true }); // build output only; never committed
  }
  symlinkSync(external, out);
  console.log(`desktop/ is inside a synced folder (iCloud Drive, or similar); out/ → ${external} so codesign is not racing the sync.`);
  return out;
}

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
ensureOutDir();
const builderArgs = [];
if (wantMac) builderArgs.push('--mac');
if (wantWin) builderArgs.push('--win');
run(process.execPath, [join(rootDir, 'node_modules', 'electron-builder', 'cli.js'), ...builderArgs, '--publish', 'never']);

step('6. gate: the packaged app');
const gateOptions = { requireSigned: args.includes('--require-signed'), requireNotarized: args.includes('--require-notarized') };
let failures = 0;
for (const target of targets) failures += checkPackaged(target, undefined, gateOptions);
if (failures > 0) {
  console.error(`\n${failures} packaged app check(s) failed — do not ship out/.`);
  process.exit(1);
}

step('artifacts');
const out = join(desktopDir, 'out');
if (lstatSync(out).isSymbolicLink()) console.log(`  (out/ → ${readlinkSync(out)})`);
for (const name of readdirSync(out)) {
  const path = join(out, name);
  const stats = statSync(path);
  if (stats.isFile() && /\.(dmg|zip|exe|yml)$/.test(name) && name !== 'builder-debug.yml') {
    console.log(`  ${name}  ${stats.size >= 1024 * 1024 ? `${(stats.size / 1024 / 1024).toFixed(0)} MB` : `${(stats.size / 1024).toFixed(0)} KB`}`);
  }
}
console.log(
  '\nSigning is decided by the environment: a Developer ID in the keychain (or CSC_LINK) signs the Mac build, ' +
    'APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID notarise it, WIN_CSC_LINK signs the Windows one. ' +
    'The gate above says what this build got. An unsigned Windows installer shows SmartScreen (More info → Run anyway).',
);
