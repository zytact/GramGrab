import { chmod, copyFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const artifacts = new URL('../../../artifacts/', import.meta.url);
const manifests = new URL('../manifests/', import.meta.url);

await Promise.all(
  ['chromium.json', 'firefox.json'].map(name =>
    copyFile(new URL(name, manifests), new URL(name, artifacts))
  )
);
await Promise.all([
  copyFile(
    new URL('../../cli/bin/gramgrab.cmd', import.meta.url),
    new URL('gramgrab.cmd', artifacts)
  ),
  copyFile(
    new URL('../bin/gramgrab-native-host.cmd', import.meta.url),
    new URL('gramgrab-native-host.cmd', artifacts)
  ),
  chmod(new URL('gramgrab.mjs', artifacts), 0o755),
  chmod(new URL('gramgrab-native-host.mjs', artifacts), 0o755),
]);

const files = (await readdir(artifacts)).filter(name =>
  ['.mjs', '.json', '.cmd'].some(extension => name.endsWith(extension))
);
const checksums = await Promise.all(
  files.sort().map(async name => {
    const contents = await readFile(new URL(name, artifacts));
    return `${createHash('sha256').update(contents).digest('hex')}  ${name}`;
  })
);
await writeFile(new URL('SHA256SUMS', artifacts), `${checksums.join('\n')}\n`);
