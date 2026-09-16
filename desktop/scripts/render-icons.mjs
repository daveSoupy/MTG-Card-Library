// Renders the desktop app's icons (Phase 32). Run once per artwork change,
// from desktop/:  node scripts/render-icons.mjs
//
// - build/icon.png (1024px): the app icon. electron-builder turns it into the
//   .icns and .ico itself. Same mark as the web app's home-screen icon
//   (web/public/icons/icon.svg, from web/scripts/render-icons.mjs).
// - assets/trayTemplate.png + @2x (16/32px): the macOS menu-bar icon. A
//   "template" image is black-with-alpha; macOS tints it for light and dark
//   menu bars, and Electron treats any file ending in "Template" as one.
// - assets/tray.png (32px): the Windows system-tray icon, in colour.
//
// Rasterised with macOS's QuickLook thumbnailer, as the web icons are.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const APP_ICON_SVG = readFileSync(join(here, '..', '..', 'web', 'public', 'icons', 'icon.svg'), 'utf8');

// Three fanned cards, solid black: the same idea as the app icon, reduced to
// what reads at 16px.
const TRAY_TEMPLATE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <g fill="#000" transform="translate(16 36)">
    <rect x="-5.5" y="-29" width="11" height="17" rx="1.8" transform="rotate(-17)"/>
    <rect x="-5.5" y="-29" width="11" height="17" rx="1.8" transform="rotate(17)"/>
    <rect x="-5.5" y="-30" width="11" height="17" rx="1.8"/>
    <rect x="-3.8" y="-28.3" width="7.6" height="13.6" rx="1.1" fill="#fff" fill-opacity="0.6"/>
  </g>
</svg>
`;

const work = mkdtempSync(join(tmpdir(), 'mtg-desktop-icons-'));
try {
  const render = (outDir, name, source, size) => {
    const stem = name.replace(/\.png$/, '');
    const input = join(work, `${stem}.svg`);
    writeFileSync(input, source);
    execFileSync('qlmanage', ['-t', '-s', String(size), '-o', work, input], { stdio: 'ignore' });
    mkdirSync(outDir, { recursive: true });
    renameSync(join(work, `${stem}.svg.png`), join(outDir, name));
    console.log(`wrote ${join(outDir, name)} (${size}px)`);
  };
  const build = join(here, '..', 'build');
  const assets = join(here, '..', 'assets');
  render(build, 'icon.png', APP_ICON_SVG, 1024);
  render(assets, 'trayTemplate.png', TRAY_TEMPLATE_SVG, 16);
  render(assets, 'trayTemplate@2x.png', TRAY_TEMPLATE_SVG, 32);
  render(assets, 'tray.png', APP_ICON_SVG, 32);
} finally {
  rmSync(work, { recursive: true, force: true });
}
