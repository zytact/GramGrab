import { Effect } from 'effect';
import type { InstagramLogin } from '@gramgrab/protocol';
import { NetworkError } from '../effect/errors.ts';
import type { ProtocolOperation } from '../instagram-protocol/config.ts';
import { IG_API_GRAPHQL_HEADERS } from './headers.ts';
import { InstagramRequests, readJson, requireOk } from './requests.ts';

const DTSG_TOKEN = /"DTSGInitialData",\[\],\{"token":"([^"]+)"/;
/** Each login's token, kept in this worker's memory only and never stored. */
const cachedTokens: Partial<Record<InstagramLogin, string>> = {};

/** The text of `response` up to the first chunk after which `enough` holds, or all of it. */
async function readUntil(response: Response, enough: (text: string) => boolean) {
  if (!response.body) return response.text();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
    if (enough(text)) {
      await reader.cancel().catch(() => undefined);
      return text;
    }
  }
}

/**
 * Reads Instagram Web's home page for the requests' login, and keeps the `fb_dtsg` token it names
 * for `withDtsgToken`. A refused page forgets the token, so the next request reads it first. The
 * download stops once the page names the token and `enough` holds, since both sit near its start.
 */
export const readHomePage = (enough: (page: string) => boolean = () => true) =>
  Effect.gen(function* () {
    const requests = yield* InstagramRequests;
    const response = yield* requests.fetch('https://www.instagram.com/', {
      headers: { Accept: 'text/html' },
    });
    delete cachedTokens[requests.login];
    yield* requireOk(response);
    const page = yield* Effect.tryPromise({
      try: () => readUntil(response, text => DTSG_TOKEN.test(text) && enough(text)),
      catch: cause => new NetworkError({ cause }),
    });
    const token = DTSG_TOKEN.exec(page)?.[1];
    cachedTokens[requests.login] = token;
    return { page, token };
  });

/** The home page's token, or an empty one when Instagram refuses the page. */
const readToken = readHomePage().pipe(
  Effect.map(({ token }) => token ?? ''),
  Effect.catchTags({
    RateLimited: () => Effect.succeed(''),
    GraphQLRequestFailed: () => Effect.succeed(''),
  })
);

const isPage = (response: Response) =>
  response.headers.get('content-type')?.includes('text/html') ?? false;

/**
 * Sends a request with Instagram Web's `fb_dtsg` form token, read from its home page. Instagram
 * answers an expired token with that page, so a cached token that gets it is read again once.
 */
const withDtsgToken = <E, R>(send: (token: string) => Effect.Effect<Response, E, R>) =>
  Effect.gen(function* () {
    const cached = cachedTokens[(yield* InstagramRequests).login];
    const response = yield* send(cached ?? (yield* readToken));
    if (!cached || !isPage(response)) return response;
    return yield* send(yield* readToken);
  });

/** Sends a configured Instagram Web query with the login's `fb_dtsg` token and reads its JSON. */
export const postWebQuery = (
  operation: ProtocolOperation,
  variables: Readonly<Record<string, unknown>>
) =>
  Effect.gen(function* () {
    const candidate = operation.candidates[0]!;
    const request = candidate.requests[0]!;
    const requests = yield* InstagramRequests;
    const send = (dtsgToken: string) =>
      requests.fetch(request.endpoint, {
        method: 'POST',
        csrf: true,
        headers: { ...IG_API_GRAPHQL_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          [candidate.kind]: candidate.id,
          variables: JSON.stringify(variables),
          fb_dtsg: dtsgToken,
        }),
      });
    return yield* readJson(yield* withDtsgToken(send));
  });
