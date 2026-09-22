#!/usr/bin/env node
// Assembles what the packaged app ships as Resources/mtg-library: the
// Dockerfile's runtime stage, once per target platform.
//
//   node scripts/stage.mjs [--target darwin-arm64|win32-x64]...
//
// Needs `npm run build` at the root first (server/dist and web/dist). Output
// is desktop/staging/<target>/, shaped like the repository because
// server/dist/index.js finds schema.sql and web/dist by walking up from its
// own path:
//
//   package.json  package-lock.json  schema.sql
//   server/package.json  server/dist/  server/scripts/check-sqlite.mjs
//   web/dist/
//   node_modules/          production-only, from a fresh `npm ci`, with the
//                          @mtg-library workspace symlinks removed
//
// Why not point electron-builder at the workspace: the root node_modules
// holds the server's runtime dependencies (hoisted) *and* Electron, the
// builder, tsx, vite… A fresh `npm ci --omit=dev` into a scratch directory
// is the only way to get exactly the runtime set. The workspace symlinks
// must go because electron-builder follows symlinks and would package
// server/ and web/ a second time, sources and dev output included.
//
// The one file that differs per target is better-sqlite3's native binary.
// Its prebuilt releases are keyed by platform, arch and Node ABI, so after
// one install the Windows binary is fetched with prebuild-install
// --platform win32 --arch x64 --target <the bundled Node version> — no
// Windows machine, no compiler. Each staged binary's header is checked
// (Mach-O for darwin, PE for win32) so a wrong download fails here rather
// than on a user's machine.

import { execFileSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NODE_TARGETS, bundledNodeVersion } from './fetch-node.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const desktopDir = join(here, '..');
const rootDir = join(desktopDir, '..');
const stagingDir = join(desktopDir, 'staging');

const PLATFORM_ARCH = {
  'darwin-arm64': { platform: 'darwin', arch: 'arm64' },
  'darwin-x64': { platform: 'darwin', arch: 'x64' },
  'win32-x64': { platform: 'win32', arch: 'x64' },
};

export function stagedDir(target) {
  return join(stagingDir, target);
}

function requireBuilt(path, hint) {
  if (!existsSync(path)) throw new Error(`${path} is missing — ${hint}`);
}

/** The native binary's magic bytes: Mach-O 64-bit on darwin, "MZ" on Windows. */
export function binaryFormat(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    if (head[0] === 0x4d && head[1] === 0x5a) return 'pe';
    const magic = head.readUInt32LE(0);
    if (magic === 0xfeedfacf || magic === 0xcffaedfe) return 'mach-o';
    if (magic === 0xcafebabe || magic === 0xbebafeca) return 'mach-o'; // fat
    return 'unknown';
  } finally {
    closeSync(fd);
  }
}

/**
 * Which CPU the binary is actually for — 'x64', 'arm64', 'fat' or null.
 *
 * The format check above cannot tell an Intel Mach-O from an Apple silicon
 * one: both are MH_MAGIC_64. That did not matter while every Mac build was
 * arm64 on an arm64 machine, but a cross-built target is fetched by
 * `prebuild-install --arch`, and if that ever resolved to the host's binary
 * instead the mistake would not surface until someone opened the app on the
 * machine we cannot test on. Four bytes of header answer it here instead.
 */
export function binaryArch(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(8);
    readSync(fd, head, 0, 8, 0);

    // Windows PE: e_lfanew at 0x3c points at "PE\0\0" + a 2-byte machine id.
    if (head[0] === 0x4d && head[1] === 0x5a) {
      const offset = Buffer.alloc(4);
      readSync(fd, offset, 0, 4, 0x3c);
      const coff = Buffer.alloc(6);
      readSync(fd, coff, 0, 6, offset.readUInt32LE(0));
      if (coff.toString('latin1', 0, 4) !== 'PE\0\0') return null;
      return { 0x8664: 'x64', 0x014c: 'ia32', 0xaa64: 'arm64' }[coff.readUInt16LE(4)] ?? null;
    }

    const magic = head.readUInt32LE(0);
    // A fat binary carries several; naming one would be a lie.
    if (magic === 0xcafebabe || magic === 0xbebafeca) return 'fat';
    if (magic !== 0xfeedfacf && magic !== 0xcffaedfe) return null;
    // cpu_type_t, with the 0x01000000 CPU_ARCH_ABI64 bit set on both.
    const cpu = magic === 0xfeedfacf ? head.readUInt32LE(4) : head.readUInt32BE(4);
    return { 0x01000007: 'x64', 0x0100000c: 'arm64' }[cpu] ?? null;
  } finally {
    closeSync(fd);
  }
}

function stageBase(base) {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });

  // The manifests npm needs to reproduce the tree, then the tree itself.
  for (const file of ['package.json', 'package-lock.json', 'schema.sql']) cpSync(join(rootDir, file), join(base, file));
  for (const workspace of ['server', 'web', 'desktop']) {
    mkdirSync(join(base, workspace), { recursive: true });
    cpSync(join(rootDir, workspace, 'package.json'), join(base, workspace, 'package.json'));
  }
  console.log('npm ci --omit=dev (server workspace only)');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--workspace=server', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: base,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
  rmSync(join(base, 'node_modules', '@mtg-library'), { recursive: true, force: true });
  // Every .bin directory, nested ones included: symlinks to CLI entry points
  // nothing at runtime calls. electron-builder follows symlinks when copying,
  // and 7-Zip (the NSIS packer) fails the build on a dangling one.
  for (const bin of walk(join(base, 'node_modules'), { directories: true, keep: (name) => name === '.bin' })) {
    rmSync(bin, { recursive: true, force: true });
  }
  // The C source better-sqlite3 builds from. We ship the prebuilt .node and
  // never compile on a user's machine, so the amalgamation is 9.5MB of dead
  // weight in every installer, per target.
  rmSync(join(base, 'node_modules', 'better-sqlite3', 'deps'), { recursive: true, force: true });

  // Third-party test fixtures — about 1,200 files. Worth removing for the
  // bytes, but the real reason is signing: @electron/osx-sign tries to sign
  // every file whose *content* looks binary, and these directories carry .jpg,
  // .zip and similar fixtures that codesign then stores a signature for in an
  // extended attribute, which the outer bundle refuses when sealing Resources.
  // That is the hazard electron-builder.yml's `signIgnore` works around; this
  // removes the cause rather than the symptom. (Keep `signIgnore` — it also
  // covers the web client's own PNG icons, which do ship.)
  for (const dir of walk(join(base, 'node_modules'), {
    directories: true,
    keep: (name) => name === 'test' || name === 'tests',
  })) {
    rmSync(dir, { recursive: true, force: true });
  }

  // The web and desktop manifests only existed for npm's benefit.
  rmSync(join(base, 'desktop'), { recursive: true, force: true });
  rmSync(join(base, 'web'), { recursive: true, force: true });

  cpSync(join(rootDir, 'server', 'dist'), join(base, 'server', 'dist'), { recursive: true });
  mkdirSync(join(base, 'server', 'scripts'));
  cpSync(join(rootDir, 'server', 'scripts', 'check-sqlite.mjs'), join(base, 'server', 'scripts', 'check-sqlite.mjs'));
  cpSync(join(rootDir, 'web', 'dist'), join(base, 'web', 'dist'), { recursive: true });
  // Source maps are dev output. This sweeps the whole staged tree, not just
  // server/dist: dependencies ship their own (638 files, 14MB measured), and
  // web/dist carried a 2MB one until the production build stopped emitting it.
  // Walking `base` covers all three without having to know which.
  for (const map of walk(base, { keep: (name) => name.endsWith('.map') })) unlinkSync(map);
  const links = walk(base, { symlinks: true, keep: () => true });
  if (links.length > 0) throw new Error(`symlinks left in the staged tree:\n  ${links.join('\n  ')}`);
}

/** Paths under `dir` whose name `keep` accepts: files by default, or directories, or symlinks (not descended into). */
function walk(dir, { keep, directories = false, symlinks = false }) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (symlinks && keep(entry.name)) found.push(path);
    } else if (entry.isDirectory()) {
      if (directories && keep(entry.name)) found.push(path);
      else found.push(...walk(path, { keep, directories, symlinks }));
    } else if (!directories && !symlinks && keep(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function fetchSqliteBinary(dir, target) {
  const { platform, arch } = PLATFORM_ARCH[target];
  const pkgDir = join(dir, 'node_modules', 'better-sqlite3');
  const binary = join(pkgDir, 'build', 'Release', 'better_sqlite3.node');
  try {
    unlinkSync(binary);
  } catch {
    // Fresh install with --ignore-scripts has no binary yet.
  }
  console.log(`prebuild-install better-sqlite3 for ${platform}-${arch}, node ${bundledNodeVersion()}`);
  execFileSync(
    process.execPath,
    [
      join(dir, 'node_modules', 'prebuild-install', 'bin.js'),
      '--runtime', 'node',
      '--target', bundledNodeVersion(),
      '--platform', platform,
      '--arch', arch,
      '--force',
    ],
    { cwd: pkgDir, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const format = binaryFormat(binary);
  const expected = platform === 'win32' ? 'pe' : 'mach-o';
  if (format !== expected) throw new Error(`${binary} is ${format}, expected ${expected}`);
  const builtFor = binaryArch(binary);
  if (builtFor !== arch) throw new Error(`${binary} is ${builtFor ?? 'an unreadable architecture'}, expected ${arch}`);
  console.log(`  ${binary.replace(dir, '')} ok (${format}, ${builtFor})`);
}

export function stage(targets) {
  requireBuilt(join(rootDir, 'server', 'dist', 'index.js'), 'run `npm run build` at the root first');
  requireBuilt(join(rootDir, 'web', 'dist', 'index.html'), 'run `npm run build` at the root first');
  for (const target of targets) if (!NODE_TARGETS[target]) throw new Error(`unknown target ${target}`);

  const base = join(stagingDir, 'base');
  stageBase(base);
  for (const target of targets) {
    const dir = stagedDir(target);
    rmSync(dir, { recursive: true, force: true });
    cpSync(base, dir, { recursive: true });
    fetchSqliteBinary(dir, target);
  }
  rmSync(base, { recursive: true, force: true });
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const targets = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--target') targets.push(args[++i]);
  if (targets.length === 0) targets.push(...Object.keys(NODE_TARGETS));
  stage(targets);
  for (const target of targets) console.log(`staged ${stagedDir(target)}`);
}
