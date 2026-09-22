#!/usr/bin/env node
// The gate: is the packaged app's server tree right, and does its SQLite
// have what schema.sql needs?
//
//   node scripts/check-packaged.mjs --target darwin-arm64|darwin-x64|win32-x64 [--resources <dir>]
//                                   [--require-signed] [--require-notarized]
//
// Checks the layout under the app's resources directory (the walk-up from
// server/dist to schema.sql and web/dist, the bundled Node, the native
// binary's format for the target) and, when the target is the machine this
// runs on, executes server/scripts/check-sqlite.mjs with the *packaged* Node
// against the *packaged* better-sqlite3 — FTS5, the trigram tokenizer and a
// clean schema load. Phase 34's release workflow runs this on each
// platform's runner; scripts/package.mjs runs it after every build.
//
// With a bundled Node there is no rebuild step to lose FTS5 in, so this has
// nothing to catch. It stays because it is cheap, and because the day that
// decision is reversed it is the only thing that would notice.
//
// Phase 34 adds the updater's files (app-update.yml, electron-updater inside
// app.asar) and, on a Mac, the signature: the .app verifies strictly, the
// bundled Node is signed with the hardened runtime and the allow-jit
// entitlement (without it the first search is a crash, found five seconds
// into a local run rather than twenty minutes into notarisation), and the
// authority is a Developer ID. An unsigned build is reported, not failed —
// a Mac with no certificate can still package for itself — unless
// --require-signed says otherwise; --require-notarized adds spctl and
// stapler, which only pass after notarisation, so the workflow asks for both.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { binaryArch, binaryFormat } from './stage.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const desktopDir = join(here, '..');

const args = process.argv.slice(2);
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
// @electron/asar comes with electron-builder; nothing at runtime needs it.
const require = createRequire(import.meta.url);

/**
 * Where electron-builder leaves the unpacked app's resources for each target.
 *
 * The directory is the platform key plus an arch suffix, and the suffix is
 * dropped for the *default* arch, which is x64 — so the Intel build is in
 * out/mac with no suffix and Apple silicon is in out/mac-arm64. Only the
 * directory works that way; the artifact names carry both arches, because
 * artifactName is set in electron-builder.yml (see the comment there).
 */
export function defaultResourcesDir(target) {
  if (target === 'darwin-arm64') return join(desktopDir, 'out', 'mac-arm64', 'MTG Library.app', 'Contents', 'Resources');
  if (target === 'darwin-x64') return join(desktopDir, 'out', 'mac', 'MTG Library.app', 'Contents', 'Resources');
  if (target === 'win32-x64') return join(desktopDir, 'out', 'win-unpacked', 'resources');
  throw new Error(`unknown target ${target}`);
}

/** Runs a command and returns its combined output, or null when it exits non-zero. */
function tryRun(file, argv) {
  try {
    return execFileSync(file, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return null;
  }
}

/** `codesign -d` prints its report to stderr, so both streams, whatever the exit status. */
function codesignInfo(path, extra = []) {
  const result = spawnSync('codesign', ['-d', '--verbose=2', ...extra, path], { encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * The macOS signature, as a set of findings. `signed` false means no
 * signature at all (a local build on a Mac with no Developer ID), which the
 * caller decides whether to fail on.
 */
export function checkSignature(appPath, node) {
  const verify = tryRun('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const unsigned = /not signed at all/.test(codesignInfo(appPath));
  const appInfo = codesignInfo(appPath, ['-vv']);
  const nodeInfo = codesignInfo(node, ['--entitlements', '-', '--xml']);
  return {
    signed: !unsigned,
    valid: verify !== null,
    developerId: /Authority=Developer ID Application/.test(appInfo),
    teamId: /TeamIdentifier=([A-Z0-9]+)/.exec(appInfo)?.[1] ?? null,
    nodeHardened: /flags=0x[0-9a-f]+\(.*runtime.*\)/.test(nodeInfo),
    nodeAllowsJit: /com\.apple\.security\.cs\.allow-jit/.test(nodeInfo),
    nodeSameTeam: /TeamIdentifier=([A-Z0-9]+)/.exec(nodeInfo)?.[1] === (/TeamIdentifier=([A-Z0-9]+)/.exec(appInfo)?.[1] ?? '-'),
  };
}

export function checkPackaged(target, resources = defaultResourcesDir(target), { requireSigned = false, requireNotarized = false } = {}) {
  const isWindows = target.startsWith('win32');
  const node = join(resources, 'node', isWindows ? 'node.exe' : 'node');
  const tree = join(resources, 'mtg-library');
  const required = [
    node,
    join(resources, 'node', 'LICENSE'),
    join(tree, 'schema.sql'),
    join(tree, 'package.json'),
    join(tree, 'server', 'package.json'),
    join(tree, 'server', 'dist', 'index.js'),
    join(tree, 'server', 'dist', 'sync', 'syncWorker.js'),
    join(tree, 'server', 'scripts', 'check-sqlite.mjs'),
    join(tree, 'web', 'dist', 'index.html'),
    join(tree, 'web', 'dist', 'sw.js'),
    join(tree, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    join(tree, 'node_modules', 'fastify', 'package.json'),
    join(tree, 'node_modules', '@fastify', 'static', 'package.json'),
  ];
  let failures = 0;
  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  console.log(`Packaged layout (${target}): ${resources}`);
  for (const path of required) check(path.replace(resources, ''), existsSync(path));
  // Nothing of the workspace leaked in, and nothing the app would mistake for itself.
  check('no node_modules/@mtg-library symlinks', !existsSync(join(tree, 'node_modules', '@mtg-library')));
  check('no server/src', !existsSync(join(tree, 'server', 'src')));
  check('no Resources/app directory', !existsSync(join(resources, 'app')));
  check('shell in app.asar', existsSync(join(resources, 'app.asar')));

  const expected = isWindows ? 'pe' : 'mach-o';
  // The arch, not just the format. Mach-O 64-bit is the same magic number on
  // Intel and Apple silicon, so the format check alone would pass an arm64
  // binary sitting inside the Intel app — and that mistake only shows up on
  // the machine this build cannot be tested on. A fat binary satisfies any
  // target. See binaryArch in stage.mjs.
  const wantArch = target.endsWith('-arm64') ? 'arm64' : 'x64';
  const archOk = (path) => [wantArch, 'fat'].includes(binaryArch(path));
  if (existsSync(node)) {
    check(`bundled node is ${expected}`, binaryFormat(node) === expected);
    check(`bundled node is ${wantArch}`, archOk(node), `${binaryArch(node)}`);
  }
  const sqlite = required[10];
  if (existsSync(sqlite)) {
    check(`better_sqlite3.node is ${expected}`, binaryFormat(sqlite) === expected);
    check(`better_sqlite3.node is ${wantArch}`, archOk(sqlite), `${binaryArch(sqlite)}`);
  }

  // Phase 34: what the updater needs. app-update.yml is electron-builder's
  // copy of the publish config; electron-updater must be in the asar, not
  // left in the workspace's hoisted node_modules.
  check('Resources/app-update.yml', existsSync(join(resources, 'app-update.yml')));
  const asarPath = join(resources, 'app.asar');
  if (existsSync(asarPath)) {
    const asar = require('@electron/asar');
    const listed = new Set(asar.listPackage(asarPath).map((p) => p.replace(/\\/g, '/')));
    check('electron-updater in app.asar', listed.has('/node_modules/electron-updater/package.json'));
    check('dist/updates.js in app.asar', listed.has('/dist/updates.js'));
  }

  if (!isWindows && process.platform === 'darwin') {
    const appPath = join(resources, '..', '..');
    const sig = checkSignature(appPath, node);
    if (!sig.signed) {
      check('signed (Developer ID)', !requireSigned, requireSigned ? 'unsigned — no identity was available to electron-builder' : 'unsigned: runs where it was built; a downloaded copy needs xattr -d com.apple.quarantine');
    } else {
      check('codesign --verify --deep --strict', sig.valid);
      check('signed by a Developer ID Application certificate', sig.developerId, sig.teamId ? `team ${sig.teamId}` : '');
      check('bundled node: hardened runtime', sig.nodeHardened);
      check('bundled node: com.apple.security.cs.allow-jit', sig.nodeAllowsJit);
      check('bundled node: same team as the app', sig.nodeSameTeam);
    }
    if (requireNotarized) {
      // Both only pass after notarisation: spctl asks Gatekeeper, stapler
      // checks the ticket electron-builder attached so it passes offline.
      const spctl = tryRun('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
      check('spctl --assess accepts the app', spctl !== null);
      const stapled = tryRun('xcrun', ['stapler', 'validate', appPath]);
      check('stapler validate: ticket stapled to the app', stapled !== null);
    }
  }

  const host = `${process.platform}-${process.arch}`;
  if (host === target && failures === 0) {
    console.log('\ncheck-sqlite.mjs on the packaged node + better-sqlite3:');
    try {
      const output = execFileSync(node, [join(tree, 'server', 'scripts', 'check-sqlite.mjs')], { encoding: 'utf8' });
      const passed = /All checks passed/.test(output);
      console.log(output.split('\n').map((line) => `    ${line}`).join('\n'));
      check('check-sqlite.mjs passed', passed);
    } catch (error) {
      console.log(String(error.stdout ?? error.message));
      check('check-sqlite.mjs passed', false);
    }
  } else if (host !== target) {
    console.log(`\n(check-sqlite.mjs needs a ${target} machine to run the packaged node; layout and binary formats checked only)`);
  }
  return failures;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const target = argValue('--target') ?? `${process.platform}-${process.arch}`;
  const failures = checkPackaged(target, argValue('--resources'), {
    requireSigned: args.includes('--require-signed'),
    requireNotarized: args.includes('--require-notarized'),
  });
  console.log(failures === 0 ? '\nPackaged app checks passed.' : `\n${failures} packaged app check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
