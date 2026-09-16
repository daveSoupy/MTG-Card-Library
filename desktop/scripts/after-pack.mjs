// electron-builder's afterPack hook: runs once the app directory is
// assembled, before signing.
//
// On macOS, strips every extended attribute from the bundle. codesign
// refuses a file carrying Finder metadata ("resource fork, Finder
// information, or similar detritus not allowed"), and there are thousands of
// such files in a fresh bundle: macOS 14+ stamps `com.apple.provenance` on
// everything extracted from a downloaded archive — Electron's own zip, out of
// electron-builder's cache — and the frameworks carry `com.apple.FinderInfo`.
// None of it is ours and none of it is wanted in the shipped app.
//
// Nothing to do on Windows; the hook is a no-op there so one config serves both.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** @param {import('app-builder-lib').AfterPackContext} context */
export async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('xattr', ['-cr', app], { stdio: 'inherit' });
  console.log(`  • afterPack: cleared extended attributes under ${app}`);
}
