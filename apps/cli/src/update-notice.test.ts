import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { isNewer, updateNotice } from './update-notice.ts';

const DAY = 24 * 60 * 60 * 1000;
let directory: string;
let cacheFile: string;

const unreachable = (): Promise<string> => {
  throw new Error('GitHub was asked again');
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gramgrab-notice-'));
  cacheFile = join(directory, 'nested/update-check.json');
});

afterEach(() => rm(directory, { recursive: true, force: true }));

describe('update notice', () => {
  it('announces a newer release and reuses the answer for a day', async () => {
    const fetchLatest = () => Promise.resolve('1.2.0');

    expect(await updateNotice({ current: '1.1.0', now: 0, cacheFile, fetchLatest })).toBe(
      'Update available: 1.1.0 → 1.2.0. Run "gramgrab update".\n'
    );
    expect(
      await updateNotice({ current: '1.1.0', now: DAY - 1, cacheFile, fetchLatest: unreachable })
    ).toContain('1.2.0');
  });

  it('asks again after a day', async () => {
    await updateNotice({ current: '1.1.0', now: 0, cacheFile, fetchLatest: async () => '1.1.0' });

    const notice = await updateNotice({
      current: '1.1.0',
      now: DAY,
      cacheFile,
      fetchLatest: async () => '1.1.1',
    });

    expect(notice).toContain('1.1.1');
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual({
      checkedAt: DAY,
      latest: '1.1.1',
    });
  });

  it('waits a day after a failed check', async () => {
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('offline'));
    };

    expect(
      await updateNotice({ current: '1.1.0', now: 0, cacheFile, fetchLatest: failing })
    ).toBeUndefined();
    await updateNotice({ current: '1.1.0', now: DAY - 1, cacheFile, fetchLatest: failing });

    expect(calls).toBe(1);
  });

  it('compares versions numerically', () => {
    expect(isNewer('1.10.0', '1.9.0')).toBe(true);
    expect(isNewer('1.1.0', '1.1.0')).toBe(false);
    expect(isNewer('1.0.9', '1.1.0')).toBe(false);
  });
});
