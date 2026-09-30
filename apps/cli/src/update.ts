import { spawn } from 'node:child_process';
import type { StatusResult } from '@gramgrab/protocol';

const INSTALL_SCRIPT_URL = 'https://github.com/zytact/GramGrab/releases/latest/download/install.sh';

/** Runs the latest release's install.sh, which swaps in the new CLI and native host. */
export async function update(): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error(
      'gramgrab update is not available on Windows. Download gramgrab-tools.tar.gz from the latest release.'
    );
  }
  const response = await fetch(INSTALL_SCRIPT_URL);
  if (!response.ok) throw new Error(`Could not download the installer: HTTP ${response.status}`);
  const script = await response.text();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('sh', ['-s'], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('close', code =>
      code === 0 ? resolve() : reject(new Error(`The installer exited with ${code}.`))
    );
    child.stdin.end(script);
  });
}

export function versionSkewHint(status: StatusResult): string | undefined {
  if (status.extensionVersion === status.hostVersion) return undefined;
  return `The extension is ${status.extensionVersion} but the CLI and native host are ${status.hostVersion}. Run "gramgrab update", or restart the browser if the extension is the older one.\n`;
}
