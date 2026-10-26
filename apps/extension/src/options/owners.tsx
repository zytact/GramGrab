import { createContext, useContext } from 'react';
import type { HeldWatch, InstagramLogin, WatchListResult, WatchSummary } from '@gramgrab/protocol';

/** One signed-in login's verified Watch list. */
export interface LoginList {
  readonly login: InstagramLogin;
  readonly list: WatchListResult;
}

/**
 * A Watch on the page and the login that owns it. A held Watch's owner is not signed in, so no
 * command can run for it.
 */
export type PageWatch =
  | { readonly held: false; readonly owner: InstagramLogin; readonly watch: WatchSummary }
  | { readonly held: true; readonly owner: HeldWatch['owner']; readonly watch: WatchSummary };

export type Owner = PageWatch['owner'];

/** Every signed-in login's Watches, then the `held` ones. */
export const pageWatches = (
  lists: readonly LoginList[],
  held: readonly HeldWatch[]
): PageWatch[] => [
  ...lists.flatMap(({ login, list }) =>
    list.watches.map(watch => ({ held: false as const, owner: login, watch }))
  ),
  ...held.map(({ owner, watch }) => ({ held: true as const, owner, watch })),
];

export const OWNER_LABEL: Record<Owner, string> = {
  main: 'Main',
  linked: 'Linked',
  other: 'Other login',
};

/** The owner of a Watch by its ID, or undefined when every Watch on the page has the same owner. */
export const OwnerTagContext = createContext<(watchId: string) => Owner | undefined>(
  () => undefined
);

export function OwnerTag({ watchId }: { watchId: string }) {
  const owner = useContext(OwnerTagContext)(watchId);
  return owner ? (
    <span className={`opt-owner opt-owner-${owner}`}>{OWNER_LABEL[owner]}</span>
  ) : null;
}
