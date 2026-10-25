import { Effect, Option, Schema } from 'effect';
import { AccountId, type InstagramLogin } from '@gramgrab/protocol';
import { LinkedLoginUnavailable } from '../effect/errors.ts';
import { browser, type HeadersReceivedDetails } from '../lib/browser.ts';
import { SESSION_RULE_ID } from './session-rules.ts';
import type { LinkRefusalReason, LinkedLoginState } from '../messaging/contracts.ts';

/**
 * The linked second Instagram login (Beta, Chromium only). Its cookies are copied once from an
 * Incognito window and kept in `storage.local` until Unlink. A request for it carries
 * `LINKED_MARKER`, and a session rule that only matches requests outside tabs sets its `Cookie`
 * header. Removing this module and its callers leaves the main login as the only one.
 */
const LINKED_LOGIN_KEY = 'linked-instagram-login';
const LINKED_MARKER = 'gg_login';
const MARKER = `${LINKED_MARKER}=linked`;
const INSTAGRAM_URLS = ['https://*.instagram.com/*'];

const LinkedLogin = Schema.Struct({
  version: Schema.Literal(1),
  accountId: AccountId,
  cookies: Schema.Record({ key: Schema.String, value: Schema.String }),
  /** Instagram ended the session. Linking the same account again clears it. */
  ended: Schema.optional(Schema.Literal(true)),
});
type LinkedLogin = typeof LinkedLogin.Type;

/** Why an Incognito window offers no login to link. */
type LinkRefusal = Extract<
  LinkRefusalReason,
  'incognito-not-allowed' | 'no-incognito-window' | 'not-signed-in'
>;

export const linkedLoginSupported = () => browser.linkedLogin !== undefined;

/** Where the linked login stands, read from storage in any extension page. */
export async function linkedLoginState(): Promise<LinkedLoginState> {
  if (!linkedLoginSupported()) return 'unsupported';
  const linked = await readLinkedLogin();
  if (!linked) return 'unlinked';
  return linked.ended ? 'ended' : 'linked';
}

export async function readLinkedLogin(): Promise<LinkedLogin | undefined> {
  const stored = await browser.storage
    .get(LINKED_LOGIN_KEY)
    .catch((): Record<string, unknown> => ({}));
  return Option.getOrUndefined(Schema.decodeUnknownOption(LinkedLogin)(stored[LINKED_LOGIN_KEY]));
}

let writes: Promise<unknown> = Promise.resolve();

/** Applies `change` to the stored login one write at a time, then installs the matching rule. */
function updateLinkedLogin(
  change: (current: LinkedLogin | undefined) => LinkedLogin | undefined
): Promise<void> {
  const run = async () => {
    const current = await readLinkedLogin();
    const next = change(current);
    if (next === current) return;
    if (next)
      await browser.storage.set({ [LINKED_LOGIN_KEY]: Schema.encodeSync(LinkedLogin)(next) });
    else await browser.storage.remove(LINKED_LOGIN_KEY);
    await installRule(next);
  };
  const result = writes.then(run, run);
  writes = result.catch(() => undefined);
  return result;
}

const cookieHeader = (cookies: Readonly<Record<string, string>>) =>
  Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

async function installRule(login: LinkedLogin | undefined): Promise<void> {
  if (!linkedLoginSupported()) return;
  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [SESSION_RULE_ID.linkedCookie],
    addRules: login
      ? [
          {
            id: SESSION_RULE_ID.linkedCookie,
            priority: 1,
            condition: {
              urlFilter: MARKER,
              requestDomains: ['instagram.com'],
              tabIds: [-1],
              resourceTypes: ['xmlhttprequest', 'other'],
            },
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                { header: 'cookie', operation: 'set', value: cookieHeader(login.cookies) },
              ],
            },
          },
        ]
      : [],
  });
}

/** Fails when `login` is the linked login and it is not linked or its session ended. */
export const requireLogin = (login: InstagramLogin) =>
  login === 'main'
    ? Effect.void
    : Effect.flatMap(Effect.promise(readLinkedLogin), current => {
        if (!current || !linkedLoginSupported())
          return Effect.fail(new LinkedLoginUnavailable({ reason: 'missing' }));
        return current.ended
          ? Effect.fail(new LinkedLoginUnavailable({ reason: 'ended' }))
          : Effect.void;
      });

/**
 * `url` marked for the linked login, without the browser's cookies, so Instagram's `Set-Cookie`
 * replies never touch the main session. The session rule adds the linked cookies instead.
 */
export async function linkedRoute(url: string) {
  const login = await readLinkedLogin();
  const marked = new URL(url);
  marked.searchParams.set(LINKED_MARKER, 'linked');
  return {
    url: marked.href,
    credentials: 'omit' as const,
    csrfToken: async () => login?.cookies.csrftoken,
  };
}

/** Reads the Instagram cookies of the open Incognito window, which must hold a signed-in login. */
export async function incognitoCookies(): Promise<
  | {
      readonly _tag: 'found';
      readonly accountId: string;
      readonly cookies: Record<string, string>;
    }
  | { readonly _tag: 'refused'; readonly reason: LinkRefusal }
> {
  const apis = browser.linkedLogin;
  if (!apis || !(await apis.isAllowedIncognitoAccess()))
    return { _tag: 'refused', reason: 'incognito-not-allowed' };
  const store = (await apis.getAllCookieStores()).find(candidate => candidate.id !== '0');
  if (!store) return { _tag: 'refused', reason: 'no-incognito-window' };
  const found = await apis.getAllCookies({ domain: 'instagram.com', storeId: store.id });
  const cookies = Object.fromEntries(found.map(cookie => [cookie.name, cookie.value]));
  const accountId = Schema.decodeUnknownOption(AccountId)(cookies.ds_user_id);
  if (!cookies.sessionid || Option.isNone(accountId))
    return { _tag: 'refused', reason: 'not-signed-in' };
  return { _tag: 'found', accountId: accountId.value, cookies };
}

export const saveLinkedLogin = (accountId: string, cookies: Record<string, string>) =>
  updateLinkedLogin(() => LinkedLogin.make({ version: 1, accountId, cookies }));

/** Puts back the login a refused link replaced, or none. */
export const restoreLinkedLogin = (previous: LinkedLogin | undefined) =>
  updateLinkedLogin(() => previous);

/** Deletes the stored cookies and the rule that sends them. */
export const unlinkLogin = () => updateLinkedLogin(() => undefined);

/** Records that Instagram no longer accepts the linked session, so its Watches stop. */
export const markLinkedEnded = () =>
  updateLinkedLogin(current =>
    current && !current.ended ? LinkedLogin.make({ ...current, ended: true }) : current
  );

/** Session rules do not survive a browser restart, so the worker installs its rule on start. */
export const restoreLinkedRule = () => readLinkedLogin().then(installRule, () => undefined);

const expired = (attributes: readonly string[], value: string) =>
  value === '' ||
  value === '""' ||
  attributes.some(attribute => {
    const [name = '', ...rest] = attribute.split('=');
    const key = name.trim().toLowerCase();
    if (key === 'max-age') return Number(rest.join('=')) <= 0;
    return key === 'expires' && Date.parse(rest.join('=')) <= Date.now();
  });

/** `cookies` after the `Set-Cookie` lines of one response, or the same object when none change. */
export function absorbSetCookie(
  cookies: Readonly<Record<string, string>>,
  lines: readonly string[]
): Readonly<Record<string, string>> {
  const next: Record<string, string> = { ...cookies };
  let changed = false;
  for (const line of lines.flatMap(value => value.split('\n'))) {
    const [pair = '', ...attributes] = line.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (expired(attributes, value)) {
      changed ||= name in next;
      delete next[name];
    } else if (next[name] !== value) {
      changed = true;
      next[name] = value;
    }
  }
  return changed ? next : cookies;
}

function onHeadersReceived(details: HeadersReceivedDetails) {
  // A page can load a marked URL itself; its reply carries the main login's cookies, not these.
  if (details.tabId !== -1 || !details.url.includes(MARKER)) return;
  const lines = (details.responseHeaders ?? []).flatMap(header =>
    header.name.toLowerCase() === 'set-cookie' && header.value ? [header.value] : []
  );
  if (lines.length === 0) return;
  void updateLinkedLogin(current => {
    if (!current) return current;
    const cookies = absorbSetCookie(current.cookies, lines);
    return cookies === current.cookies ? current : LinkedLogin.make({ ...current, cookies });
  }).catch(() => undefined);
}

/**
 * Keeps the stored cookies in step with what Instagram sets on linked responses. It replaces `rur`
 * on almost every response, so a copy that ignored `Set-Cookie` would go stale.
 */
export function listenForLinkedCookies(): void {
  browser.linkedLogin?.onHeadersReceived.addListener(onHeadersReceived, { urls: INSTAGRAM_URLS }, [
    'responseHeaders',
    'extraHeaders',
  ]);
}
