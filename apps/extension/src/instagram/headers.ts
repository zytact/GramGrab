import { Effect } from 'effect';
import { browser } from '../lib/browser.ts';
import { protocolConfig } from '../instagram-protocol/config.ts';
import { NetworkError } from '../effect/errors.ts';
import { InstagramRequests } from './requests.ts';

const IG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'X-IG-App-ID': protocolConfig.client.appId,
  'X-Requested-With': 'XMLHttpRequest',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Mode': 'cors',
  Referer: 'https://www.instagram.com/',
} as const;

export const IG_GRAPHQL_HEADERS = { ...IG_HEADERS, Origin: 'https://www.instagram.com' } as const;
export const IG_API_GRAPHQL_HEADERS = {
  ...IG_GRAPHQL_HEADERS,
  Referer: 'https://www.instagram.com/',
  'X-ASBD-ID': protocolConfig.client.asbdId,
} as const;

/** Reads `csrftoken` for an Instagram request that sends it straight back; never stored. */
export const readCsrfToken = Effect.tryPromise({
  try: () => browser.cookies.get({ url: 'https://www.instagram.com/', name: 'csrftoken' }),
  catch: cause => new NetworkError({ cause }),
}).pipe(Effect.map(cookie => cookie?.value ?? ''));

const DTSG_TOKEN = /"DTSGInitialData",\[\],\{"token":"([^"]+)"/;
let dtsgToken: string | undefined;

/**
 * Instagram Web's `fb_dtsg` form token, which its Posts queries require. It is read from the home
 * page and kept in this worker's memory only. `fresh` reads it again, for when it expired.
 */
export const readDtsgToken = (fresh = false) =>
  Effect.gen(function* () {
    if (dtsgToken && !fresh) return dtsgToken;
    const requests = yield* InstagramRequests;
    const response = yield* requests.fetch('https://www.instagram.com/', {
      credentials: 'include',
      headers: { Accept: 'text/html' },
    });
    const page = response.ok
      ? yield* Effect.tryPromise({
          try: () => response.text(),
          catch: cause => new NetworkError({ cause }),
        })
      : '';
    dtsgToken = DTSG_TOKEN.exec(page)?.[1];
    return dtsgToken ?? '';
  });
