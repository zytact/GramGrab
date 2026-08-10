import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vite-plus/test';

const fixtureDirectory = 'apps/extension/src/whatsapp/__fixtures__';

describe('WhatsApp repository fixture policy', () => {
  it('commits policy only, never a WhatsApp capture or derived artifact', async () => {
    await expect(readdir(fixtureDirectory)).resolves.toEqual(['README.md']);

    const policy = await readFile(`${fixtureDirectory}/README.md`, 'utf8');
    expect(policy).toContain('intentionally empty of capture data');
    expect(policy).toContain('may be committed');
    expect(policy).toContain('synthetic DOM nodes and byte streams');
  });
});
