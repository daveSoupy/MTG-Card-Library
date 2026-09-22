// Pre-compress the built client so the server never compresses it per request.
//
//   node scripts/precompress.mjs [dist-dir]
//
// @fastify/static's `preCompressed` option looks for `<file>.br` and
// `<file>.gz` beside each asset and serves whichever the browser accepts,
// falling back to the original. That makes the bundle free to serve: the CPU
// is spent once here rather than on every cold load, which is the difference
// that matters on a Pi or an old NAS serving a phone.
//
// Brotli runs at quality 11 — the slow, best setting — precisely because this
// is build time and the output is reused forever. The server's *dynamic*
// responses take the opposite trade and prefer gzip; see the comment on the
// @fastify/compress registration in server/src/index.ts.
import { brotliCompress, gzip, constants } from 'node:zlib';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const br = promisify(brotliCompress);
const gz = promisify(gzip);

// Text formats only. Images, fonts and anything already compressed gain
// nothing and would just double their own bytes on disk.
const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|webmanifest|txt|ico)$/i;

// Below about a kilobyte the header overhead eats the saving, and this is the
// same threshold the server applies to dynamic responses.
const MIN_BYTES = 1024;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const dist = process.argv[2] ?? 'dist';

try {
  await stat(dist);
} catch {
  console.error(`precompress: ${dist} does not exist — run vite build first`);
  process.exit(1);
}

let raw = 0;
let brotli = 0;
let gzipped = 0;
let count = 0;

for await (const file of walk(dist)) {
  // Never compress a compressed artefact, including one from an earlier run.
  if (/\.(br|gz)$/i.test(file) || !COMPRESSIBLE.test(file)) continue;

  const source = await readFile(file);
  if (source.byteLength < MIN_BYTES) continue;

  const [b, g] = await Promise.all([
    br(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
      },
    }),
    gz(source, { level: 9 }),
  ]);

  await Promise.all([writeFile(`${file}.br`, b), writeFile(`${file}.gz`, g)]);

  raw += source.byteLength;
  brotli += b.byteLength;
  gzipped += g.byteLength;
  count += 1;
}

const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
console.log(
  count === 0
    ? 'precompress: nothing large enough to compress'
    : `precompress: ${count} files, ${kb(raw)} raw -> ${kb(gzipped)} gzip, ${kb(brotli)} brotli`,
);
