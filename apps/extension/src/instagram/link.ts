import { Effect, Either } from 'effect';
import type { InstagramLogin } from '@gramgrab/protocol';
import type {
  LinkLoginResponse,
  LinkedLoginState,
  LoginNamesResponse,
} from '../messaging/contracts.ts';
import { cachedViewer, fetchViewer } from '../watch/identity.ts';
import { refreshBadge } from '../watch/attention.ts';
import { resumeAfterPerson } from '../watch/scheduler.ts';
import { PersonRequests } from './requests.ts';
import {
  incognitoCookies,
  linkedLoginState,
  readLinkedLogin,
  restoreLinkedLogin,
  saveLinkedLogin,
  unlinkLogin,
} from './linked-login.ts';

const viewerAs = (login: InstagramLogin) =>
  Effect.runPromise(fetchViewer.pipe(Effect.either, Effect.provide(PersonRequests(login))));

/**
 * Links the login of the open Incognito window: copies its Instagram cookies, then confirms the
 * account with the viewer read as that login. It must differ from the main login. Linking the
 * account that was linked before resumes its Watches.
 */
export async function linkLogin(): Promise<LinkLoginResponse> {
  const found = await incognitoCookies();
  if (found._tag === 'refused') return found;
  const previous = await readLinkedLogin();
  const main = await viewerAs('main');
  if (Either.isLeft(main)) return { _tag: 'refused', reason: 'main-unverified' };
  await saveLinkedLogin(found.accountId, found.cookies);
  const linked = await viewerAs('linked');
  const verified =
    Either.isRight(linked) && linked.right.accountId === found.accountId ? linked.right : undefined;
  const same = main.right.accountId === verified?.accountId;
  if (verified && !same) {
    await resumeAfterPerson('linked');
    await refreshBadge();
    return { _tag: 'linked', username: verified.username };
  }
  await restoreLinkedLogin(previous);
  return { _tag: 'refused', reason: same ? 'same-login' : 'not-verified' };
}

const nameOf = async (login: InstagramLogin) => {
  const cached = await cachedViewer(login);
  if (cached) return cached.username;
  const viewer = await viewerAs(login);
  return Either.isRight(viewer) ? viewer.right.username : undefined;
};

/**
 * The usernames the login picker shows, read from this browser session's cache or one viewer
 * query per login. Nothing is asked while no second login is linked, since the picker is hidden.
 */
export async function loginNames(): Promise<LoginNamesResponse> {
  const state = await linkedLoginState();
  if (state !== 'linked' && state !== 'ended') return {};
  const [main, linked] = await Promise.all([
    nameOf('main'),
    state === 'linked' ? nameOf('linked') : undefined,
  ]);
  return { ...(main ? { main } : {}), ...(linked ? { linked } : {}) };
}

export async function unlinkLinkedLogin(): Promise<LinkedLoginState> {
  await unlinkLogin();
  await refreshBadge();
  return linkedLoginState();
}
