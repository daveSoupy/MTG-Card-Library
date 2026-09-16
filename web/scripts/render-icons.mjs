// Renders the home-screen icons from one SVG mark (Phase 31).
//
// Writes web/public/icons/: icon.svg (rounded corners, also the favicon),
// icon-maskable.svg (full-bleed, art inside the 80% safe zone), and the PNGs
// the manifest and index.html reference. Rasterised with macOS's QuickLook
// thumbnailer (`qlmanage`), which renders SVG with alpha and ships with the
// OS — the repo carries no image tooling, and this runs once per artwork
// change, not per build. Run from web/:
//
//   node scripts/render-icons.mjs
//
// Original artwork: a fan of card backs in the app's accent colour on its
// dark background. No card art, no Wizards marks.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = new URL('../public/icons/', import.meta.url).pathname;

// styles.css :root — the default (dark) theme.
const BG = '#10131a';
const ACCENT = '#d98a3f';
const ACCENT_DIM = '#7a4f22';
const ACCENT_MID = '#b8702e';
const TEXT = '#e7ecf5';

/**
 * The mark, on a 512-unit canvas. `scale` shrinks the artwork about the
 * centre (0.8 keeps it inside a maskable icon's safe zone); `rx` rounds the
 * background's corners (0 for full-bleed).
 */
function svg({ rx, scale }) {
  const card = (rotate, fill, front) => `
    <g transform="rotate(${rotate} 256 392)">
      <rect x="181" y="150" width="150" height="210" rx="14" fill="${fill}" stroke="${BG}" stroke-width="8"/>
      ${front ? `
      <rect x="199" y="168" width="114" height="174" rx="8" fill="none" stroke="${BG}" stroke-width="5" opacity="0.55"/>
      <circle cx="256" cy="255" r="30" fill="${BG}" opacity="0.9"/>
      <circle cx="256" cy="255" r="18" fill="${TEXT}"/>` : ''}
    </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="${rx}" fill="${BG}"/>
  <g transform="translate(256 240) scale(${scale}) translate(-256 -256)">
    ${card(-22, ACCENT_DIM, false)}
    ${card(22, ACCENT_DIM, false)}
    ${card(-11, ACCENT_MID, false)}
    ${card(11, ACCENT_MID, false)}
    ${card(0, ACCENT, true)}
  </g>
</svg>
`;
}

const ROUNDED = svg({ rx: 108, scale: 0.92 });
const MASKABLE = svg({ rx: 0, scale: 0.78 });

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'icon.svg'), ROUNDED);
writeFileSync(join(OUT, 'icon-maskable.svg'), MASKABLE);

const work = mkdtempSync(join(tmpdir(), 'mtg-icons-'));
try {
  const render = (name, source, size) => {
    // qlmanage names its output after the input file, so render from a temp
    // copy named for the target and move the result into place.
    const stem = name.replace(/\.png$/, '');
    const input = join(work, `${stem}.svg`);
    writeFileSync(input, source);
    execFileSync('qlmanage', ['-t', '-s', String(size), '-o', work, input], { stdio: 'ignore' });
    renameSync(join(work, `${stem}.svg.png`), join(OUT, name));
    console.log(`wrote ${name} (${size}px)`);
  };
  render('icon-192.png', ROUNDED, 192);
  render('icon-512.png', ROUNDED, 512);
  render('icon-maskable-512.png', MASKABLE, 512);
  // iOS ignores alpha and applies its own mask: full-bleed, opaque.
  render('apple-touch-icon.png', MASKABLE, 180);
} finally {
  rmSync(work, { recursive: true, force: true });
}
