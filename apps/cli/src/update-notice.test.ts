import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { isNewer, updateNotice } from './update-notice.ts';

const DAY = 24 * 60 * 60 * 1000;
let root: string;
let cacheDirectory: string;

// A synchronous throw escapes updateNotice, so a test fails if GitHub is asked again.
const unreachable = (): Promise<string> => {
  throw new Error('GitHub was asked again');
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gramgrab-notice-'));
  cacheDirectory = join(root, 'nested');
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('update notice', () => {
  it('announces a newer release and reuses the answer for the rest of the day', async () => {
    expect(
      await updateNotice({
        current: '1.1.0',
        now: 0,
        cacheDirectory,
        fetchLatest: async () => '1.2.0',
      })
    ).toBe('Update available: 1.1.0 → 1.2.0. Run "gramgrab update".\n');
    expect(
      await updateNotice({
        current: '1.1.0',
        now: DAY - 1,
        cacheDirectory,
        fetchLatest: unreachable,
      })
    ).toContain('1.2.0');
  });

  it('asks again the next day and keeps only that day’s claim', async () => {
    await updateNotice({
      current: '1.1.0',
      now: 0,
      cacheDirectory,
      fetchLatest: async () => '1.1.0',
    });

    const notice = await updateNotice({
      current: '1.1.0',
      now: DAY,
      cacheDirectory,
      fetchLatest: async () => '1.1.1',
    });

    expect(notice).toContain('1.1.1');
    expect(JSON.parse(await readFile(join(cacheDirectory, 'update-check.json'), 'utf8'))).toEqual({
      latest: '1.1.1',
    });
    expect((await readdir(cacheDirectory)).sort()).toEqual(['update-check.json', 'update-claim-1']);
  });

  it('asks GitHub once when commands overlap', async () => {
    let calls = 0;
    const slow = async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 50));
      return '1.2.0';
    };

    await Promise.all(
      Array.from({ length: 5 }, () =>
        updateNotice({ current: '1.1.0', now: 0, cacheDirectory, fetchLatest: slow })
      )
    );

    expect(calls).toBe(1);
  });

  it('waits for the next day after a failed check', async () => {
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('offline'));
    };

    expect(
      await updateNotice({ current: '1.1.0', now: 0, cacheDirectory, fetchLatest: failing })
    ).toBeUndefined();
    await updateNotice({ current: '1.1.0', now: DAY - 1, cacheDirectory, fetchLatest: failing });

    expect(calls).toBe(1);
  });

  it('compares versions numerically', () => {
    expect(isNewer('1.10.0', '1.9.0')).toBe(true);
    expect(isNewer('1.1.0', '1.1.0')).toBe(false);
    expect(isNewer('1.0.9', '1.1.0')).toBe(false);
  });
});
