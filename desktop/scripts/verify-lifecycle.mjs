#!/usr/bin/env node
// Walks Phase 32's lifecycle checks against the development app, without a
// click: launches `electron --inspect` with MTG_DESKTOP_INSPECT=1, drives the
// tray's actions through the `__mtgDesktop` handle main.ts exposes under that
// flag, and asserts what each one should do. Run after `npm run build` at the
// root, from desktop/:
//
//   node scripts/verify-lifecycle.mjs [--data-dir <existing library>] [--keep]
//                                     [--app <path to a packaged app's executable>]
//
// With --app it drives the packaged build instead (e.g.
// "~/Applications/MTG Library.app/Contents/MacOS/MTG Library"), which adds
// the login-item checks — only a packaged app registers one. The scratch
// userData keeps that run's config apart from the real install's, but the
// login item is per app path, so the run ends with it registered again.
//
// Covers the doc's items 4 (close hides, server keeps answering, Quit stops
// it), 4a (the power assertion while sharing + keep-awake are both on), 5
// (LAN refused with sharing off, answering with it on) and 6 (a busy port is
// skipped, the chosen one persisted and reused on the next launch). The
// window opens on screen while it runs. Items 1–3 are manual — see the
// phase doc. Phase 33 adds: the mDNS advertisement follows the sharing
// toggle (browsed with `dns-sd` on macOS), and "Pair a phone…" lands the
// window on the Data page's pairing panel. Phase 34 adds: a manual update
// check settles in a state the tray can show (packaged), or says it needs
// the installed app (development).

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const desktopDir = join(here, '..');
const args = process.argv.slice(2);
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const keep = args.includes('--keep');
const packagedApp = argValue('--app');
const INSPECT_PORT = 9333;

const scratch = mkdtempSync(join(tmpdir(), 'mtg-desktop-verify-'));
const userData = join(scratch, 'userData');
const dataDir = argValue('--data-dir') ?? join(scratch, 'library');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   (${detail})` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function health(host, port) {
  try {
    const response = await fetch(`http://${host}:${port}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function until(label, predicate, { timeoutMs = 60_000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

/**
 * Phase 33: the instance ids `dns-sd -B _mtglibrary._tcp` can see right now,
 * macOS only (the tool ships with it). Browses for two seconds, then resolves
 * each listed instance for its TXT record.
 */
async function advertisedIds() {
  if (process.platform !== 'darwin') return null;
  const browse = spawn('dns-sd', ['-B', '_mtglibrary._tcp']);
  let listing = '';
  browse.stdout.on('data', (chunk) => { listing += chunk; });
  await sleep(2_000);
  browse.kill();
  const names = [...listing.matchAll(/_mtglibrary\._tcp\.\s+(.+?)\s*$/gm)].map((m) => m[1]);
  const ids = [];
  for (const name of names) {
    const lookup = spawn('dns-sd', ['-L', name, '_mtglibrary._tcp']);
    let record = '';
    lookup.stdout.on('data', (chunk) => { record += chunk; });
    await sleep(1_500);
    lookup.kill();
    const id = /\bid=(\S+)/.exec(record)?.[1];
    if (id) ids.push(id);
  }
  return ids;
}

/** A listener on the port the app would otherwise take first, to force the search. */
function holdPort(port) {
  return new Promise((resolve, reject) => {
    const holder = createServer();
    holder.once('error', reject);
    holder.listen(port, '0.0.0.0', () => resolve(holder));
  });
}

// ---------- the inspector ----------------------------------------------------

class MainProcess {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    const target = await until('the inspector', async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json();
        return list.find((t) => t.webSocketDebuggerUrl) ?? false;
      } catch {
        return false;
      }
    }, { timeoutMs: 30_000 });
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
  }

  /** Evaluates an expression in main; the handle's async methods are awaited. */
  async evaluate(expression) {
    const id = this.nextId++;
    const result = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluation threw');
    return result.result.value;
  }

  state() {
    return this.evaluate('__mtgDesktop.state()');
  }

  close() {
    this.ws?.close();
  }
}

// ---------- one launch ---------------------------------------------------------

function launch() {
  // The real binary, not the `.bin/electron` wrapper, so `child.pid` is the
  // app's own — pmset reports assertions by pid. Hoisted to the root by npm
  // workspaces; the electron package records the binary's path in path.txt.
  const electronDir = join(desktopDir, '..', 'node_modules', 'electron');
  const binary = packagedApp ?? join(electronDir, 'dist', readFileSync(join(electronDir, 'path.txt'), 'utf8').trim());
  const child = spawn(
    binary,
    packagedApp ? [`--inspect=${INSPECT_PORT}`] : [`--inspect=${INSPECT_PORT}`, '.'],
    {
      cwd: desktopDir,
      env: { ...process.env, MTG_DESKTOP_INSPECT: '1', MTG_DESKTOP_USER_DATA: userData, MTG_DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve({ code, stderr })));
  return { child, exited };
}

async function main() {
  const lan = lanAddress();
  console.log(`${packagedApp ? `packaged app ${packagedApp}` : 'development app'}\nscratch ${scratch}\ndata dir ${dataDir}\nLAN address ${lan ?? '(none — item 5 skipped)'}\n`);

  // Item 6, first half: 8080 busy → the app must pick another port.
  let holder = null;
  try {
    holder = await holdPort(8080);
    console.log('holding 8080 so the app has to look past it');
  } catch {
    console.log('8080 already held by something else; that will do');
  }

  console.log('\nLaunch 1');
  let run = launch();
  let main = new MainProcess();
  await main.connect();
  await until('the server to answer', async () => {
    // The inspector answers before main.ts has finished loading, so the
    // handle may not exist on the first polls.
    const s = await main.state().catch(() => null);
    return s !== null && s.running && s.port !== null && (await health('127.0.0.1', s.port));
  });
  let state = await main.state();
  const port = state.port;
  check('server up on a port other than 8080', port !== 8080, `port ${port}`);
  await until('the window to load the app', async () => (await main.state()).url?.startsWith(`http://127.0.0.1:${port}/`));
  state = await main.state();
  check('window shows the web client', state.url.startsWith(`http://127.0.0.1:${port}/`), state.url);
  check('window visible after a user launch', state.visible === true);
  check('tray icon loaded (not an empty image)', state.trayIcon && !state.trayIcon.empty, JSON.stringify(state.trayIcon));
  if (process.platform === 'darwin') check('tray icon is a macOS template image', state.trayIcon?.template === true);

  const config = JSON.parse(readFileSync(join(userData, 'desktop-config.json'), 'utf8'));
  check('port persisted in desktop-config.json', config.port === port);
  check('sharing off by default', config.sharing === false);
  check('launch at login on by default', config.launchAtLogin === true);

  // Item 4: close hides, the server keeps answering, the icon reopens it.
  await main.evaluate('__mtgDesktop.closeWindow()');
  await sleep(300);
  state = await main.state();
  check('close hides the window', state.visible === false);
  check('server still answers after close', await health('127.0.0.1', port));
  await main.evaluate('__mtgDesktop.showWindow()');
  await sleep(300);
  check('showWindow (the tray / Dock action) brings it back', (await main.state()).visible === true);

  // Item 5: sharing off → LAN refused; on → LAN answers (a restart with MTG_HOST=0.0.0.0).
  if (lan) {
    check('sharing off: LAN address refused', !(await health(lan, port)));
    const pidBefore = state.pid;
    await main.evaluate('__mtgDesktop.setSharing(true)');
    await until('the restarted server', async () => {
      const s = await main.state();
      return s.running && s.pid !== pidBefore && (await health('127.0.0.1', s.port));
    });
    state = await main.state();
    check('sharing on restarts the child', state.pid !== pidBefore, `pid ${pidBefore} → ${state.pid}`);
    check('sharing on keeps the same port', state.port === port);
    check('sharing on: LAN address answers', await health(lan, port));

    // Phase 33: sharing on → advertised under this library's id, and the
    // instance endpoint lists the LAN address the QR will carry.
    const instance = await (await fetch(`http://127.0.0.1:${port}/api/v1/instance`)).json();
    check('instance endpoint lists a LAN address while sharing', instance.addresses.includes(lan), instance.addresses.join(', '));
    check('shell reports the advertise flag on', state.advertise === true);
    const seen = await advertisedIds();
    if (seen !== null) check('dns-sd sees this library while sharing', seen.includes(instance.instanceId), `saw [${seen.join(', ')}]`);

    // "Pair a phone…" lands the window on the pairing panel.
    await main.evaluate('__mtgDesktop.openPairing()');
    await until('the pairing panel', async () => (await main.state()).url === `http://127.0.0.1:${port}/data#pair`);
    check('Pair a phone… opens /data#pair in the window', true);
  }

  // Item 4a: the power assertion needs both toggles.
  await main.evaluate('__mtgDesktop.setKeepAwake(true)');
  state = await main.state();
  check('keep-awake + sharing → powerSaveBlocker held', state.blocking === true);
  if (process.platform === 'darwin') {
    // `prevent-app-suspension` shows up as a NoIdleSleepAssertion owned by the app's pid.
    const assertions = execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' });
    check('macOS reports a NoIdleSleepAssertion from this app', new RegExp(`pid ${run.child.pid}\\(.*NoIdleSleepAssertion`).test(assertions));
  }
  await main.evaluate('__mtgDesktop.setKeepAwake(false)');
  check('keep-awake off → blocker released', (await main.state()).blocking === false);
  await main.evaluate('__mtgDesktop.setKeepAwake(true)');
  if (lan) {
    await main.evaluate('__mtgDesktop.setSharing(false)');
    await until('the restarted server', async () => {
      const s = await main.state();
      return s.running && (await health('127.0.0.1', s.port));
    });
    check('sharing off again → blocker released even with keep-awake on', (await main.state()).blocking === false);
    check('sharing off again: LAN address refused', !(await health(lan, port)));
    // Phase 33: and the advertisement is gone, not just stale.
    const instance = await (await fetch(`http://127.0.0.1:${port}/api/v1/instance`)).json();
    check('sharing off: instance endpoint lists no address', instance.addresses.length === 0);
    check('shell reports the advertise flag off', (await main.state()).advertise === false);
    const seen = await advertisedIds();
    if (seen !== null) check('dns-sd no longer sees this library', !seen.includes(instance.instanceId), `saw [${seen.join(', ')}]`);
  }

  // Item 4: a fresh install registers a login item; unchecking removes it.
  if (packagedApp) {
    check('packaged first launch registered a login item', (await main.state()).loginItem === true);
    await main.evaluate('__mtgDesktop.setLaunchAtLogin(false)');
    check('unchecking Launch at login removes it', (await main.state()).loginItem === false);
    await main.evaluate('__mtgDesktop.setLaunchAtLogin(true)');
    check('checking it again registers it', (await main.state()).loginItem === true);

    // Phase 34: the updater is wired and a check ends in a state the tray can
    // show. Against a repository with no release yet (or no network) the
    // honest answer is an error, recorded in the log — still the machine
    // working; "up to date" or "downloading" once a release exists.
    const version = (await main.state()).version;
    check('packaged app reports its version', /^\d+\.\d+\.\d+/.test(version ?? ''), version);
    const update = await main.evaluate('__mtgDesktop.checkForUpdates()');
    check('check for updates settles', ['up-to-date', 'downloading', 'ready', 'error'].includes(update?.kind), JSON.stringify(update));
    check('updater state is what the tray shows', JSON.stringify((await main.state()).update) === JSON.stringify(update));
  } else {
    const update = await main.evaluate('__mtgDesktop.checkForUpdates()');
    check('development app: check for updates says it only works installed', update?.kind === 'error' && /installed app/.test(update.message), update?.message);
  }

  // Item 4: Quit stops the server, cleanly.
  const pid = (await main.state()).pid;
  await main.evaluate('__mtgDesktop.quit()');
  main.close();
  const { code } = await run.exited;
  check('app exits 0 on Quit', code === 0, `code ${code}`);
  await sleep(500);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  check('server process gone after Quit', !alive, `pid ${pid}`);
  check('port no longer answers', !(await health('127.0.0.1', port)));
  const log = readFileSync(join(userData, 'logs', 'server.log'), 'utf8');
  check('server exited on SIGTERM with code 0 (clean close)', /server exited \(code 0, signal null\)/.test(log));

  // Item 6, second half: the remembered port is reused, even with 8080 free now.
  holder?.close();
  console.log('\nLaunch 2 (8080 released)');
  run = launch();
  main = new MainProcess();
  await main.connect();
  await until('the server to answer', async () => {
    const s = await main.state();
    return s.running && s.port !== null && (await health('127.0.0.1', s.port));
  });
  state = await main.state();
  check('same port reused on relaunch', state.port === port, `port ${state.port}`);
  await main.evaluate('__mtgDesktop.quit()');
  main.close();
  await run.exited;

  console.log(failures === 0 ? '\nAll lifecycle checks passed.' : `\n${failures} check(s) failed.`);
  if (!keep) rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept ${scratch}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n${error.stack ?? error.message}`);
  process.exit(1);
});
