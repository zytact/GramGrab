// PROTOTYPE for issue #344. Fake, in-memory data. Throw away once a sidebar layout is picked.

export type Login = 'main' | 'linked';
export type Owner = Login | 'other';
export type LinkState = 'unlinked' | 'linked' | 'ended';
export type Filter = 'all' | Login;
export type View = 'attention' | 'inbox' | 'new' | 'transfer' | { readonly watchId: string };

/** One row on the page. `held` means its owner is not signed in, so it is paused and read-only. */
export interface ProtoWatch {
  readonly watchId: string;
  readonly username: string;
  readonly owner: Owner;
  readonly held: boolean;
  readonly enabled: boolean;
  readonly attention: number;
  readonly inbox: number;
  readonly lastCheckAt: number | undefined;
}

export interface SidebarProps {
  readonly linkState: LinkState;
  readonly names: Record<Login, string>;
  readonly watches: readonly ProtoWatch[];
  readonly nextCheckAt: Partial<Record<Login, number>>;
  readonly storage: { readonly usedBytes: number; readonly budgetBytes: number };
  readonly view: View;
  readonly onGo: (view: View) => void;
  readonly onLink: () => void;
  readonly onUnlink: () => void;
}

const MINUTE = 60_000;
const now = Date.now();

const NAMES = [
  'instagram',
  'a.really.long.instagram.username_30',
  'sample.account',
  'creators',
  'design.notes.daily',
  'film_photography_archive',
  'travel',
  'short',
  'music',
  'cooking.at.home.with.friends',
];

const watch = (index: number, owner: Owner, held: boolean): ProtoWatch => ({
  watchId: `${owner}-${index}`,
  username: `${NAMES[index % NAMES.length] ?? 'instagram'}${index < NAMES.length ? '' : `_${index}`}`,
  owner,
  held,
  enabled: index % 9 !== 4,
  attention: held ? 0 : index === 2 ? 2 : index === 7 ? 1 : 0,
  inbox: (index * 7) % 5,
  lastCheckAt: index === 5 ? undefined : now - ((index * 37) % 300) * MINUTE,
});

/** Main owns `mainCount` Watches. A linked login, signed in or ended, owns 6. One belongs to another login. */
export const makeWatches = (mainCount: number, linkState: LinkState): ProtoWatch[] => {
  const main = Array.from({ length: mainCount }, (_, index) => watch(index, 'main', false));
  const linked =
    linkState === 'unlinked'
      ? []
      : Array.from({ length: 6 }, (_, index) => watch(index + 3, 'linked', linkState === 'ended'));
  // Interleave so the combined list reads like a real one, sorted by name rather than owner.
  return [...main, ...linked, watch(12, 'other', true)].sort((a, b) =>
    a.username.localeCompare(b.username)
  );
};

export const makeNames = (longNames: boolean): Record<Login, string> => ({
  main: longNames ? 'main.login.with.a.long.username' : 'instagram',
  linked: longNames ? 'linked.login_with_an_even_longer_name' : 'creators',
});

export const nextChecks = (linkState: LinkState): Partial<Record<Login, number>> =>
  linkState === 'linked'
    ? { main: now + 133 * MINUTE, linked: now + 41 * MINUTE }
    : { main: now + 133 * MINUTE };

export const STORAGE = { usedBytes: 0.28 * 1024 * 1024, budgetBytes: 2 * 1024 * 1024 };

export const OWNER_LABEL: Record<Owner, string> = {
  main: 'Main',
  linked: 'Linked',
  other: 'Other login',
};

export const attentionOf = (watches: readonly ProtoWatch[]) =>
  watches.reduce((total, item) => total + (item.enabled && !item.held ? item.attention : 0), 0);

export const inboxOf = (watches: readonly ProtoWatch[]) =>
  watches.reduce((total, item) => total + item.inbox, 0);

export const manyOwners = (watches: readonly ProtoWatch[]) =>
  new Set(watches.map(item => item.owner)).size > 1;

export const ownersWithWatches = (watches: readonly ProtoWatch[]): Login[] =>
  (['main', 'linked'] as const).filter(login => watches.some(item => item.owner === login));

export const applyFilter = (watches: readonly ProtoWatch[], filter: Filter) =>
  watches.filter(item => filter === 'all' || item.owner === filter);

/** "in 2h 13m", "in 41m". The relative form the issue asks for. */
export const relativeUntil = (at: number) => {
  const minutes = Math.max(0, Math.round((at - Date.now()) / MINUTE));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 || hours >= 6 ? `in ${hours}h` : `in ${hours}h ${minutes % 60}m`;
};

const relativeAgo = (at: number) => {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / MINUTE));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

export const watchStatus = (item: ProtoWatch) =>
  item.held
    ? 'Held, owner signed out'
    : !item.enabled
      ? 'Paused'
      : item.attention > 0
        ? `${item.attention} need you`
        : item.lastCheckAt
          ? `Checked ${relativeAgo(item.lastCheckAt)}`
          : 'First check pending';

export const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

export const isWatch = (view: View, watchId: string) =>
  typeof view === 'object' && view.watchId === watchId;
