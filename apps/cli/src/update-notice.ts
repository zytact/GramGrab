import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Option, Schema } from 'effect';

const LATEST_RELEASE_URL = 'https://github.com/zytact/GramGrab/releases/latest';
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 1_500;
const CLAIM_PREFIX = 'update-claim-';

const LatestRelease = Schema.Struct({ latest: Schema.String });

const defaultCacheDirectory = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
  'gramgrab'
);

/** Reads the latest release version from GitHub's redirect, which costs no API rate limit. */
async function fetchLatestVersion(): Promise<string | undefined> {
  const response = await fetch(LATEST_RELEASE_URL, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  return response.headers.get('location')?.match(/\/tag\/v(\d+\.\d+\.\d+)$/u)?.[1];
}

export function isNewer(candidate: string, current: string): boolean {
  const [a, b] = [candidate, current].map(value => value.split('.').map(Number));
  for (let index = 0; index < 3; index++) {
    const difference = (a?.[index] ?? 0) - (b?.[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

async function readLatest(cacheFile: string): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(cacheFile, 'utf8'));
    return Option.getOrUndefined(Schema.decodeUnknownOption(LatestRelease)(raw))?.latest;
  } catch {
    return undefined;
  }
}

/**
 * Creating the day's claim file succeeds for exactly one process, so concurrent commands ask
 * GitHub once. Earlier days' claims are removed by the winner.
 */
async function claimToday(directory: string, now: number): Promise<boolean> {
  const claim = `${CLAIM_PREFIX}${Math.floor(now / DAY_MS)}`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(directory, claim), '', { flag: 'wx' });
  } catch {
    return false;
  }
  const stale = (await readdir(directory)).filter(
    name => name.startsWith(CLAIM_PREFIX) && name !== claim
  );
  await Promise.all(stale.map(name => rm(join(directory, name), { force: true })));
  return true;
}

interface UpdateNoticeOptions {
  readonly current: string;
  readonly now?: number;
  readonly cacheDirectory?: string;
  readonly fetchLatest?: () => Promise<string | undefined>;
}

/** Returns a notice when a newer release exists, asking GitHub at most once per UTC day. */
export async function updateNotice({
  current,
  now = Date.now(),
  cacheDirectory = defaultCacheDirectory,
  fetchLatest = fetchLatestVersion,
}: UpdateNoticeOptions): Promise<string | undefined> {
  const cacheFile = join(cacheDirectory, 'update-check.json');
  let latest = await readLatest(cacheFile);
  if (await claimToday(cacheDirectory, now).catch(() => false)) {
    latest = (await fetchLatest().catch(() => undefined)) ?? latest;
    if (latest) await writeFile(cacheFile, JSON.stringify({ latest })).catch(() => undefined);
  }
  if (!latest || !isNewer(latest, current)) return undefined;
  return `Update available: ${current} → ${latest}. Run "gramgrab update".\n`;
}
