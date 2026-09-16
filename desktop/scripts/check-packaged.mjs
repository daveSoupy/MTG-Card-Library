#!/usr/bin/env node
// The gate: is the packaged app's server tree right, and does its SQLite
// have what schema.sql needs?
//
//   node scripts/check-packaged.mjs --target darwin-arm64|win32-x64 [--resources <dir>]
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

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { binaryFormat } from './stage.mjs';

const here = new URL('.', import.meta.url).pathname;
const desktopDir = join(here, '..');

const args = process.argv.slice(2);
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

/** Where electron-builder leaves the unpacked app's resources for each target. */
export function defaultResourcesDir(target) {
  if (target === 'darwin-arm64') return join(desktopDir, 'out', 'mac-arm64', 'MTG Library.app', 'Contents', 'Resources');
  if (target === 'win32-x64') return join(desktopDir, 'out', 'win-unpacked', 'resources');
  throw new Error(`unknown target ${target}`);
}

export function checkPackaged(target, resources = defaultResourcesDir(target)) {
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
  if (existsSync(node)) check(`bundled node is ${expected}`, binaryFormat(node) === expected);
  const sqlite = required[10];
  if (existsSync(sqlite)) check(`better_sqlite3.node is ${expected}`, binaryFormat(sqlite) === expected);

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

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const target = argValue('--target') ?? `${process.platform}-${process.arch}`;
  const failures = checkPackaged(target, argValue('--resources'));
  console.log(failures === 0 ? '\nPackaged app checks passed.' : `\n${failures} packaged app check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
