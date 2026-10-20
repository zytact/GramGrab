import { Effect } from 'effect';
import type { InstagramLogin } from '@gramgrab/protocol';
import { NetworkError } from '../effect/errors.ts';
import { InstagramRequests } from './requests.ts';

const DTSG_TOKEN = /"DTSGInitialData",\[\],\{"token":"([^"]+)"/;
/** Each login's token, kept in this worker's memory only and never stored. */
const cachedTokens: Partial<Record<InstagramLogin, string>> = {};

const readToken = Effect.gen(function* () {
  const requests = yield* InstagramRequests;
  const response = yield* requests.fetch('https://www.instagram.com/', {
    headers: { Accept: 'text/html' },
  });
  const page = response.ok
    ? yield* Effect.tryPromise({
        try: () => response.text(),
        catch: cause => new NetworkError({ cause }),
      })
    : '';
  const token = DTSG_TOKEN.exec(page)?.[1];
  cachedTokens[requests.login] = token;
  return token ?? '';
});

const isPage = (response: Response) =>
  response.headers.get('content-type')?.includes('text/html') ?? false;

/**
 * Sends a request with Instagram Web's `fb_dtsg` form token, read from its home page. Instagram
 * answers an expired token with that page, so a cached token that gets it is read again once.
 */
export const withDtsgToken = <E, R>(send: (token: string) => Effect.Effect<Response, E, R>) =>
  Effect.gen(function* () {
    const cached = cachedTokens[(yield* InstagramRequests).login];
    const response = yield* send(cached ?? (yield* readToken));
    if (!cached || !isPage(response)) return response;
    return yield* send(yield* readToken);
  });
