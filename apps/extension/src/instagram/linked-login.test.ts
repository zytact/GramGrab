import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  WatchAdd,
  WatchList,
  WatchNeeds,
  type InstagramLogin,
  type WatchCommand,
  type WatchResult,
} from '@gramgrab/protocol';
import { createExtensionHarness, json, type ExtensionHarness } from '../test/extension-harness.ts';
import { TARGET, VIEWER, createWatchInstagram } from '../test/watch-instagram.ts';
import type { LinkLoginResponse, WatchCommandResponse } from '../messaging/contracts.ts';
import { absorbSetCookie } from './linked-login.ts';
import { SESSION_RULE_ID } from './session-rules.ts';

const START = Date.UTC(2026, 9, 1, 12);
const MINUTE = 60_000;
const LINKED = { id: '3003', username: 'instagram' };
const LINKED_COOKIES = {
  sessionid: 'linked-session',
  ds_user_id: LINKED.id,
  csrftoken: 'linked-csrf',
  rur: 'first',
};

let harness: ExtensionHarness;
let instagram: ReturnType<typeof createWatchInstagram>;
/** Who the linked cookies sign in as; null once Instagram ends that session. */
let linkedViewer: typeof LINKED | typeof VIEWER | null;
const savedBrowser = globalThis.browser;
const savedFetch = globalThis.fetch;

const marked = (url: string) => new URL(url).searchParams.get('gg_login') === 'linked';
const isViewerQuery = (url: string) =>
  new URL(url).searchParams.get('query_hash') === 'd6f4427fbe92d846298cf93df0b937d3';

beforeEach(async () => {
  vi.useFakeTimers({ now: START });
  vi.spyOn(Math, 'random').mockReturnValue(0);
  linkedViewer = LINKED;
  harness = createExtensionHarness();
  instagram = createWatchInstagram();
  harness.setFetch((url, init) => {
    if (marked(url) && isViewerQuery(url))
      return linkedViewer ? json({ data: { user: linkedViewer } }) : json({}, 401);
    if (init?.body instanceof URLSearchParams && init.body.get('doc_id') === '28036671149327607')
      return json({ data: { user: { id: TARGET.id, username: TARGET.username } } });
    return instagram.handle(url, init);
  });
  await harness.session.set({ 'watch-browser-session': true });
  await harness.loadWorker();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.browser = savedBrowser;
  globalThis.fetch = savedFetch;
});

async function settle<T>(pending: Promise<T>): Promise<T> {
  let done = false;
  let value: T | undefined;
  void pending.then(result => {
    value = result;
    done = true;
  });
  while (!done) await vi.advanceTimersByTimeAsync(1_000);
  return value as T;
}

const link = () => settle(harness.send<LinkLoginResponse>({ type: 'LINK_LOGIN' }));

async function run<T extends WatchResult['_tag']>(
  command: WatchCommand,
  expected: T,
  login: InstagramLogin = 'main'
) {
  const response = await settle(
    harness.send<WatchCommandResponse>({ type: 'WATCH_COMMAND', command, login })
  );
  if (response.result?._tag !== expected) throw new Error(JSON.stringify(response));
  return response.result as Extract<WatchResult, { _tag: T }>;
}

/** Every Instagram request so far, with the login it went out as. */
const requests = () =>
  vi.mocked(globalThis.fetch).mock.calls.flatMap(([input, init]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.hostname.endsWith('instagram.com')) return [];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return [
      {
        login: url.searchParams.get('gg_login') === 'linked' ? 'linked' : 'main',
        credentials: init?.credentials,
        csrf: headers['X-CSRFToken'],
      },
    ];
  });

const stored = () =>
  harness.local.read('linked-instagram-login') as
    | { accountId: string; cookies: Record<string, string>; ended?: true }
    | undefined;

const linkedRules = () =>
  harness.sessionRules.filter(rule => rule.id === SESSION_RULE_ID.linkedCookie);

const cookieRule = () =>
  linkedRules()[0]?.action.requestHeaders.find(header => header.header === 'cookie')?.value;

describe('linking a second login', () => {
  it('copies the Incognito cookies and confirms the account as that login', async () => {
    harness.incognito.cookies = LINKED_COOKIES;

    expect(await link()).toEqual({ _tag: 'linked', username: LINKED.username });

    expect(stored()).toMatchObject({ accountId: LINKED.id, cookies: LINKED_COOKIES });
    expect(linkedRules()).toEqual([
      expect.objectContaining({
        condition: expect.objectContaining({
          urlFilter: 'gg_login=linked',
          requestDomains: ['instagram.com'],
          tabIds: [-1],
        }),
      }),
    ]);
    expect(cookieRule()).toContain('sessionid=linked-session');
    expect(harness.sessionRules.map(rule => rule.id)).toContain(SESSION_RULE_ID.instagramOrigin);
  });

  it.each([
    [
      'incognito-not-allowed',
      () => {
        harness.incognito.allowed = false;
      },
    ],
    [
      'not-signed-in',
      () => {
        harness.incognito.cookies = { csrftoken: 'anonymous' };
      },
    ],
    [
      'same-login',
      () => {
        harness.incognito.cookies = { ...LINKED_COOKIES, ds_user_id: VIEWER.id };
        linkedViewer = VIEWER;
      },
    ],
  ] as const)('refuses %s and keeps nothing', async (reason, arrange) => {
    arrange();

    expect(await link()).toEqual({ _tag: 'refused', reason });
    expect(stored()).toBeUndefined();
    expect(linkedRules()).toEqual([]);
  });

  it('refuses while the main login cannot be confirmed, so it can never link the main login', async () => {
    harness.incognito.cookies = LINKED_COOKIES;
    instagram.state.viewer = null;

    expect(await link()).toEqual({ _tag: 'refused', reason: 'main-unverified' });
    expect(stored()).toBeUndefined();
  });

  it('deletes the cookies and the rule on Unlink', async () => {
    harness.incognito.cookies = LINKED_COOKIES;
    await link();

    await settle(harness.send({ type: 'UNLINK_LOGIN' }));

    expect(stored()).toBeUndefined();
    expect(linkedRules()).toEqual([]);
  });
});

describe('requests as the linked login', () => {
  beforeEach(async () => {
    harness.incognito.cookies = LINKED_COOKIES;
    await link();
    vi.mocked(globalThis.fetch).mockClear();
  });

  it('omit browser cookies and send the linked token, while main requests stay as they were', async () => {
    await settle(harness.send({ type: 'FETCH_INSTANTS', login: 'linked' }));
    await settle(harness.send({ type: 'FETCH_INSTANTS', login: 'main' }));

    const sent = requests();
    expect(sent.filter(request => request.login === 'linked')).not.toEqual([]);
    expect(sent.filter(request => request.login === 'linked')).toContainEqual({
      login: 'linked',
      credentials: 'omit',
      csrf: 'linked-csrf',
    });
    expect(sent.filter(request => request.login === 'main')).toContainEqual({
      login: 'main',
      credentials: 'include',
      csrf: 'csrf-token',
    });
    expect(
      sent.every(
        request => request.credentials === (request.login === 'linked' ? 'omit' : 'include')
      )
    ).toBe(true);
  });

  it('keeps the stored cookies current with what Instagram sets on linked responses only', async () => {
    harness.receiveHeaders('https://www.instagram.com/api/v1/x/?gg_login=linked', [
      'rur="second"; Path=/; Secure',
      'csrftoken=rotated; Path=/',
      'sessionid=""; Max-Age=0',
    ]);
    harness.receiveHeaders('https://www.instagram.com/api/v1/x/', ['rur=main-only; Path=/']);
    harness.receiveHeaders('https://www.instagram.com/?gg_login=linked', ['rur=from-a-tab'], 7);
    await vi.advanceTimersByTimeAsync(0);

    expect(stored()?.cookies).toEqual({
      ds_user_id: LINKED.id,
      csrftoken: 'rotated',
      rur: '"second"',
    });
    expect(cookieRule()).not.toContain('sessionid');
    expect(cookieRule()).toContain('rur="second"');
  });

  it('keeps a separate ledger, so the linked login never spends the main budget', async () => {
    const attempts = (key: string) =>
      (harness.local.read(key) as { attempts: readonly number[] } | undefined)?.attempts.length ??
      0;
    const main = attempts('instagram-requests');
    const linked = attempts('instagram-requests.linked');

    await settle(harness.send({ type: 'FETCH_INSTANTS', login: 'linked' }));

    expect(attempts('instagram-requests')).toBe(main);
    expect(attempts('instagram-requests.linked')).toBe(linked + requests().length);
  });

  it('runs a Watch of the linked login as that login', async () => {
    const added = await run(
      WatchAdd.make({
        target: TARGET.username,
        kinds: ['stories'],
        actions: ['collect'],
        acceptUnattended: true,
      }),
      'WatchAddResult',
      'linked'
    );
    expect((await run(WatchList.make(), 'WatchListResult', 'linked')).viewer.accountId).toBe(
      LINKED.id
    );
    expect((await run(WatchList.make(), 'WatchListResult')).watches).toEqual([]);
    vi.mocked(globalThis.fetch).mockClear();

    harness.fireAlarm('watch-pump');
    await vi.advanceTimersByTimeAsync(3 * MINUTE);

    expect(added.watch.accountId).toBe(TARGET.id);
    expect(requests().length).toBeGreaterThan(1);
    expect(requests().filter(request => request.login === 'linked').length).toBeGreaterThan(1);
  });
});

describe('when Instagram ends the linked session', () => {
  beforeEach(async () => {
    harness.incognito.cookies = LINKED_COOKIES;
    await link();
    await run(
      WatchAdd.make({
        target: TARGET.username,
        kinds: ['stories'],
        actions: ['collect'],
        acceptUnattended: true,
      }),
      'WatchAddResult',
      'linked'
    );
    linkedViewer = null;
  });

  it('pauses its Watches behind one attention item until the same account is linked again', async () => {
    harness.fireAlarm('watch-pump');
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(stored()?.ended).toBe(true);

    vi.mocked(globalThis.fetch).mockClear();
    harness.fireAlarm('watch-pump');
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(requests().filter(request => request.login === 'linked')).toEqual([]);
    expect((await run(WatchNeeds.make(), 'WatchNeedsResult')).items).toContainEqual({
      _tag: 'LinkedLoginAttention',
      attentionId: 'linked-login',
      code: 'IG_LINKED_LOGIN_ENDED',
    });
    const refused = await settle(
      harness.send<{ failure?: { code: string } }>({
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/p/DAbcdefghij/',
        login: 'linked',
      })
    );
    expect(refused.failure?.code).toBe('IG_LINKED_LOGIN_ENDED');

    linkedViewer = LINKED;
    expect(await link()).toMatchObject({ _tag: 'linked' });
    expect(stored()?.ended).toBeUndefined();
    expect((await run(WatchNeeds.make(), 'WatchNeedsResult')).items).not.toContainEqual(
      expect.objectContaining({ _tag: 'LinkedLoginAttention' })
    );
  });
});

it('refuses the linked login before any request while none is linked', async () => {
  const response = await settle(
    harness.send<{ failure?: { code: string } }>({
      type: 'FETCH_MEDIA',
      url: 'https://www.instagram.com/p/DAbcdefghij/',
      login: 'linked',
    })
  );

  expect(response.failure?.code).toBe('IG_LINKED_LOGIN_MISSING');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

describe('absorbSetCookie', () => {
  it('returns the same cookies when nothing changes', () => {
    const cookies = { rur: 'a' };
    expect(absorbSetCookie(cookies, ['rur=a; Path=/'])).toBe(cookies);
  });

  it('drops a cookie Instagram expires', () => {
    expect(
      absorbSetCookie({ rur: 'a', ds_user: 'b' }, [
        'ds_user=b; expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ])
    ).toEqual({ rur: 'a' });
  });
});
