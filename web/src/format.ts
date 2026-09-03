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
