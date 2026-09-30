// Writes updates.xml and updates.json for the current version into a release directory.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import packageJson from '../../../package.json' with { type: 'json' };
import { chromiumUpdateManifest, firefoxUpdateManifest } from './release.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('usage: write-update-manifests.mjs RELEASE_DIRECTORY');
const { version } = packageJson;
const xpi = await readFile(join(directory, 'gramgrab.xpi'));
await writeFile(join(directory, 'updates.xml'), chromiumUpdateManifest(version));
await writeFile(join(directory, 'updates.json'), firefoxUpdateManifest(version, xpi));
