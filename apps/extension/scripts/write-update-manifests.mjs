// Writes updates.xml, plus updates.json when the release has a signed XPI, into a release directory.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import packageJson from '../../../package.json' with { type: 'json' };
import { chromiumUpdateManifest, firefoxUpdateManifest } from './release.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('usage: write-update-manifests.mjs RELEASE_DIRECTORY');
const { version } = packageJson;
await writeFile(join(directory, 'updates.xml'), chromiumUpdateManifest(version));
const xpiPath = join(directory, 'gramgrab.xpi');
if (existsSync(xpiPath))
  await writeFile(
    join(directory, 'updates.json'),
    firefoxUpdateManifest(version, await readFile(xpiPath))
  );
