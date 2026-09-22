#!/usr/bin/env node
// Downloads the official Node binary the packaged app runs the server on.
//
//   node scripts/fetch-node.mjs [--target darwin-arm64|win32-x64]...
//
// The version is `config.nodeVersion` in desktop/package.json and must
// satisfy the root package's `engines.node` — a floor, not a target. The
// floor is what the *server* needs (Node 20); what ships here is current
// Node, because the app is downloaded rather than found on the machine and
// there is no reason to hand anyone an old runtime. One binary per target
// lands in desktop/vendor/node/<target>/ (node, or node.exe) beside Node's
// LICENSE, with the SHA-256 checked against the release's SHASUMS256.txt.
// The directory is gitignored; a fetched binary is reused until the version
// changes.
//
// Why a bundled Node rather than Electron's own: better-sqlite3's prebuilt
// binary for stock Node then works as installed, so there is no
// @electron/rebuild step and no way for a rebuild to silently drop FTS5.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const desktopDir = join(here, '..');
const rootDir = join(desktopDir, '..');

// bsdtar extracts both .tar.gz and .zip. On Windows it must be the system's
// own copy by full path: under Git Bash (the GitHub runner's `shell: bash`)
// a bare `tar` is Git's GNU tar, which reads `C:` in a path as a hostname.
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/** Node's own naming for each target, and the file inside the archive we keep. */
export const NODE_TARGETS = {
  'darwin-arm64': { archive: (v) => `node-${v}-darwin-arm64.tar.gz`, binary: 'bin/node', out: 'node' },
  'darwin-x64': { archive: (v) => `node-${v}-darwin-x64.tar.gz`, binary: 'bin/node', out: 'node' },
  'win32-x64': { archive: (v) => `node-${v}-win-x64.zip`, binary: 'node.exe', out: 'node.exe' },
};

export function bundledNodeVersion() {
  const pkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));
  const version = pkg.config?.nodeVersion;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('desktop/package.json config.nodeVersion must be an exact x.y.z');
  const engines = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).engines?.node ?? '';
  const minimum = /^>=\s*(\d+)\.(\d+)/.exec(engines);
  if (minimum) {
    const [major, minor] = version.split('.').map(Number);
    const [, minMajor, minMinor] = minimum.map(Number);
    if (major < minMajor || (major === minMajor && minor < minMinor)) {
      throw new Error(`bundled Node ${version} does not satisfy engines.node ${engines}`);
    }
  }
  return version;
}

export function vendorDir(target) {
  return join(desktopDir, 'vendor', 'node', target);
}

/** Where the fetched binary is, or null if this target has not been fetched at this version. */
export function fetchedBinary(target) {
  const spec = NODE_TARGETS[target];
  const dir = vendorDir(target);
  const marker = join(dir, 'version.txt');
  if (!existsSync(marker) || readFileSync(marker, 'utf8').trim() !== `v${bundledNodeVersion()}`) return null;
  const binary = join(dir, spec.out);
  return existsSync(binary) ? binary : null;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchNode(target) {
  const spec = NODE_TARGETS[target];
  if (!spec) throw new Error(`unknown target ${target}; one of ${Object.keys(NODE_TARGETS).join(', ')}`);
  const version = `v${bundledNodeVersion()}`;
  const existing = fetchedBinary(target);
  if (existing) {
    console.log(`node ${version} for ${target} already fetched: ${existing}`);
    return existing;
  }

  const archive = spec.archive(version);
  const base = `https://nodejs.org/dist/${version}/`;
  console.log(`fetching ${base}${archive}`);
  const [bytes, sums] = await Promise.all([download(base + archive), download(`${base}SHASUMS256.txt`)]);

  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archive)?.[0];
  if (!expected) throw new Error(`${archive} is not listed in SHASUMS256.txt`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${archive}: expected ${expected}, got ${actual}`);
  console.log(`  sha256 ok ${actual}`);

  // Unpack beside the destination, not in the OS temp dir: a rename across
  // drives fails (EXDEV), and GitHub's Windows runner keeps TEMP on C: and
  // the workspace on D:.
  mkdirSync(join(desktopDir, 'vendor'), { recursive: true });
  const work = mkdtempSync(join(desktopDir, 'vendor', 'mtg-node-'));
  try {
    const archivePath = join(work, archive);
    writeFileSync(archivePath, bytes);
    execFileSync(TAR, ['-xf', archivePath, '-C', work], { stdio: 'inherit' });
    const extracted = join(work, archive.replace(/\.(tar\.gz|zip)$/, ''));

    const dir = vendorDir(target);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    renameSync(join(extracted, spec.binary), join(dir, spec.out));
    renameSync(join(extracted, 'LICENSE'), join(dir, 'LICENSE'));
    writeFileSync(join(dir, 'version.txt'), `${version}\n`);
    console.log(`  → ${join(dir, spec.out)}`);
    return join(dir, spec.out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const targets = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--target') targets.push(args[++i]);
  if (targets.length === 0) targets.push(...Object.keys(NODE_TARGETS));
  for (const target of targets) await fetchNode(target);
}
