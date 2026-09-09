/**
 * Light / dark / follow-the-system.
 *
 * Per device rather than per user, like the display density and the pane
 * widths: it is a property of the screen you are sitting at. React-free so the
 * storage rules can be tested with plain `node --test`, and so the Data page
 * can render the control without importing App.
 */

export type Theme = 'system' | 'light' | 'dark';

export const THEME_KEY = 'mtg.theme';

export const THEME_LABEL: Record<Theme, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

/** Display order for the control: what it follows, then the two overrides. */
export const THEMES: Theme[] = ['system', 'light', 'dark'];

const isTheme = (value: unknown): value is Theme =>
  value === 'system' || value === 'light' || value === 'dark';

/**
 * Reads the saved theme.
 *
 * localStorage throws outright in some privacy modes rather than returning
 * null, so this must not be the thing that stops the app rendering.
 */
export function storedTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return isTheme(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Applies a theme to the document and remembers it.
 *
 * 'system' removes the attribute rather than setting one, so the stylesheet's
 * prefers-color-scheme rule takes over again.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
}
