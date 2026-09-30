import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Option, Schema } from 'effect';

const LATEST_RELEASE_URL = 'https://github.com/zytact/GramGrab/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 1_500;

const UpdateCheck = Schema.Struct({
  checkedAt: Schema.Number,
  latest: Schema.optional(Schema.String),
});
type UpdateCheck = typeof UpdateCheck.Type;

const defaultCacheFile = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
  'gramgrab',
  'update-check.json'
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

async function readCheck(cacheFile: string): Promise<UpdateCheck | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(cacheFile, 'utf8'));
    return Option.getOrUndefined(Schema.decodeUnknownOption(UpdateCheck)(raw));
  } catch {
    return undefined;
  }
}

async function writeCheck(cacheFile: string, check: UpdateCheck): Promise<void> {
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(check));
}

interface UpdateNoticeOptions {
  readonly current: string;
  readonly now?: number;
  readonly cacheFile?: string;
  readonly fetchLatest?: () => Promise<string | undefined>;
}

/** Returns a notice when a newer release exists, asking GitHub at most once a day. */
export async function updateNotice({
  current,
  now = Date.now(),
  cacheFile = defaultCacheFile,
  fetchLatest = fetchLatestVersion,
}: UpdateNoticeOptions): Promise<string | undefined> {
  let check = await readCheck(cacheFile);
  if (!check || now - check.checkedAt >= CHECK_INTERVAL_MS) {
    const previous = check?.latest;
    check = { checkedAt: now, latest: await fetchLatest().catch(() => previous) };
    await writeCheck(cacheFile, check).catch(() => undefined);
  }
  if (!check.latest || !isNewer(check.latest, current)) return undefined;
  return `Update available: ${current} → ${check.latest}. Run "gramgrab update".\n`;
}
