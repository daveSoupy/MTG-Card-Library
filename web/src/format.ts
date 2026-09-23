/** Human-readable byte sizes: 0 B, 940 KB, 3.4 MB, 41 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  // A little precision for the big units, none for bytes; trailing zeros trimmed.
  const decimals = power === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${parseFloat(value.toFixed(decimals))} ${units[power]}`;
}

/** A percentage 0–100, safe when the denominator is zero. */
export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

const moneyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const countFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * Dollars with thousands separators: `$72,043.89`, `-$12.00`. A missing price
 * is `—`, never `$0.00` — an unpriced card is not a free one. `wholeDollars`
 * drops `.00` when the cents are zero (`$23`), for the terse buildability strip.
 */
export function money(value: number | null | undefined, opts: { wholeDollars?: boolean } = {}): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const v = Number(value);
  const abs = Math.abs(v);
  const body = opts.wholeDollars && Number.isInteger(abs) ? countFmt.format(abs) : moneyFmt.format(abs);
  return `${v < 0 ? '-' : ''}$${body}`;
}

/** A whole count with thousands separators: `14,068`. Missing is `—`. */
export function count(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return countFmt.format(Number(value));
}
