// PROTOTYPE, throwaway. In-memory mock state for the options page prototype (issue 189).
// Every behavior here follows a resolved ticket on the "Specify Watches and the options page" map.
import { useReducer } from 'react';

export type MediaKind = 'posts' | 'stories' | 'instants' | 'avatar';
export type ActionKind = 'notify' | 'download' | 'collect';
export type Outcome = 'done' | 'failed' | 'uncertain' | 'pending';

export const MEDIA_KINDS: ReadonlyArray<MediaKind> = ['posts', 'stories', 'instants', 'avatar'];
export const ACTION_KINDS: ReadonlyArray<ActionKind> = ['notify', 'download', 'collect'];

export const kindLabel: Record<MediaKind, string> = {
  posts: 'Posts',
  stories: 'Stories',
  instants: 'Instants',
  avatar: 'Avatar changes',
};

// Coverage limits accepted on the map, shown wherever a person picks a kind.
export const kindNote: Record<MediaKind, string> = {
  posts:
    'Includes Reels. Posts published before the Watch began never count, even if they reappear.',
  stories: 'Only Stories still active when a check runs. Highlights are not watched.',
  instants: 'Only Instants that show up in your own Instants feed.',
  avatar: 'Any new picture counts, even a re-upload of the same-looking image.',
};

export const actionLabel: Record<ActionKind, string> = {
  notify: 'Notify me',
  download: 'Download automatically',
  collect: 'Collect in Watch inbox',
};

export const actionNote: Record<ActionKind, string> = {
  notify: 'One summary per check, with the account Avatar as the icon.',
  download:
    'Original files only, named like other GramGrab downloads. Chromium may still ask where to save.',
  collect: 'Keeps new media for 30 days so you can choose how to download it later.',
};

export type Avatar = { hue: number; initial: string } | 'failed';

export type Viewer = { id: string; username: string; avatar: Avatar };

export const VIEWERS = {
  main: { id: 'v-1', username: 'arnab.c', avatar: { hue: 28, initial: 'A' } },
  alt: { id: 'v-2', username: 'arnab.alt', avatar: { hue: 200, initial: 'A' } },
} satisfies Record<string, Viewer>;

export type CheckProblem =
  | 'rate-limited'
  | 'unreadable'
  | 'username-unverified'
  | 'incomplete'
  | 'storage';

export const problemText: Record<CheckProblem, string> = {
  'rate-limited': 'Instagram rate limited this check. GramGrab is waiting before trying again.',
  unreadable:
    "Instagram's response could not be read. Nothing was assumed about the account and its baseline is kept.",
  'username-unverified':
    "Could not confirm this account's current username, so Posts can't be checked yet.",
  incomplete:
    'The check stopped before it finished. Its baseline is kept and the next check starts over.',
  storage: 'Stopped because Watch storage is full.',
};

// Per-kind check health. 'off' means a kind was turned off after its baseline; the baseline stays.
export type KindHealth =
  | { tag: 'baseline' }
  | { tag: 'ok'; lastSuccess: string }
  | { tag: 'problem'; lastSuccess?: string; problem: CheckProblem }
  | { tag: 'off' };

export type Unavailable = 'story-expired' | 'avatar-changed' | 'not-in-feed' | 'not-found';

export const unavailableText: Record<Unavailable, string> = {
  'story-expired': 'Story expired',
  'avatar-changed': 'Avatar changed again since',
  'not-in-feed': 'No longer in your Instants feed',
  'not-found': 'Instagram no longer returns this item',
};

export type Child = { id: string; download?: Outcome; unavailable?: boolean };

export type Discovery = {
  id: string;
  watchId: string;
  kind: MediaKind;
  label: string;
  media: 'image' | 'video' | 'sidecar';
  children?: ReadonlyArray<Child>;
  foundDaysAgo: number;
  checkedAt: string;
  unavailable?: Unavailable;
  inInbox: boolean;
  outcomes: Partial<Record<ActionKind, Outcome>>;
  note?: string;
  acknowledged?: boolean;
};

export type Watch = {
  id: string;
  ownerId: string;
  targetId: string;
  username: string;
  formerUsername?: string;
  avatar: Avatar;
  enabled: boolean;
  kinds: Partial<Record<MediaKind, KindHealth>>;
  actions: ReadonlyArray<ActionKind>;
  lastCheck: string;
};

export type Login = 'main' | 'alt' | 'unverified';
export type Storage = 'ok' | 'full' | 'write-failed' | 'unreadable';

export type Scenario = { login: Login; storage: Storage; fromNotification: boolean };

export type State = {
  watches: ReadonlyArray<Watch>;
  discoveries: ReadonlyArray<Discovery>;
  scenario: Scenario;
  log: ReadonlyArray<string>;
};

const mainId = VIEWERS.main.id;

const initial: State = {
  scenario: { login: 'main', storage: 'ok', fromNotification: false },
  log: [],
  watches: [
    {
      id: 'w-nasa',
      ownerId: mainId,
      targetId: '528817151',
      username: 'nasa',
      avatar: { hue: 220, initial: 'N' },
      enabled: true,
      kinds: {
        posts: { tag: 'problem', lastSuccess: '2 h ago', problem: 'rate-limited' },
        instants: { tag: 'ok', lastSuccess: '12 min ago' },
        avatar: { tag: 'ok', lastSuccess: '12 min ago' },
      },
      actions: ['notify', 'download'],
      lastCheck: '12 min ago',
    },
    {
      id: 'w-natgeo',
      ownerId: mainId,
      targetId: '787132',
      username: 'natgeo',
      avatar: { hue: 48, initial: 'N' },
      enabled: true,
      kinds: {
        posts: { tag: 'ok', lastSuccess: '12 min ago' },
        stories: { tag: 'ok', lastSuccess: '12 min ago' },
        instants: { tag: 'off' },
        avatar: { tag: 'ok', lastSuccess: '12 min ago' },
      },
      actions: ['notify', 'collect'],
      lastCheck: '12 min ago',
    },
    {
      id: 'w-film',
      ownerId: mainId,
      targetId: '1394881',
      username: 'kodak.film',
      formerUsername: 'kodak_film',
      avatar: 'failed',
      enabled: false,
      kinds: { stories: { tag: 'ok', lastSuccess: '6 days ago' } },
      actions: ['collect'],
      lastCheck: '6 days ago',
    },
    {
      id: 'w-fuji',
      ownerId: mainId,
      targetId: '2219034',
      username: 'fujifilm_x',
      avatar: { hue: 140, initial: 'F' },
      enabled: true,
      kinds: {
        posts: { tag: 'baseline' },
        stories: { tag: 'ok', lastSuccess: '12 min ago' },
      },
      actions: ['notify', 'collect'],
      lastCheck: '12 min ago',
    },
    {
      id: 'w-leica',
      ownerId: mainId,
      targetId: '30544120',
      username: 'leica_camera',
      avatar: { hue: 0, initial: 'L' },
      enabled: true,
      kinds: {
        posts: { tag: 'problem', lastSuccess: '1 day ago', problem: 'username-unverified' },
        stories: { tag: 'problem', lastSuccess: '3 h ago', problem: 'unreadable' },
      },
      actions: ['download'],
      lastCheck: '12 min ago',
    },
    {
      id: 'w-alt',
      ownerId: VIEWERS.alt.id,
      targetId: '9911',
      username: 'hasselblad',
      avatar: { hue: 260, initial: 'H' },
      enabled: true,
      kinds: { posts: { tag: 'ok', lastSuccess: '3 days ago' } },
      actions: ['notify'],
      lastCheck: '3 days ago',
    },
  ],
  discoveries: [
    {
      id: 'd1',
      watchId: 'w-nasa',
      kind: 'posts',
      label: 'Post, 4 photos',
      media: 'sidecar',
      children: [
        { id: 'c1', download: 'done' },
        { id: 'c2', download: 'done' },
        { id: 'c3', download: 'failed' },
        { id: 'c4', download: 'failed' },
      ],
      foundDaysAgo: 0,
      checkedAt: '12 min ago',
      inInbox: false,
      outcomes: { notify: 'done', download: 'failed' },
      note: 'The browser refused 2 of 4 photos. Retrying downloads only those 2.',
    },
    {
      id: 'd2',
      watchId: 'w-nasa',
      kind: 'instants',
      label: 'Instant',
      media: 'video',
      foundDaysAgo: 0,
      checkedAt: '12 min ago',
      inInbox: false,
      outcomes: { notify: 'done', download: 'uncertain' },
      note: 'The browser stopped before GramGrab recorded whether it accepted this download, and its downloads list has no match.',
    },
    {
      id: 'd3',
      watchId: 'w-nasa',
      kind: 'avatar',
      label: 'Avatar change',
      media: 'image',
      foundDaysAgo: 0,
      checkedAt: '12 min ago',
      inInbox: false,
      outcomes: { notify: 'done', download: 'done' },
    },
    {
      id: 'd4',
      watchId: 'w-natgeo',
      kind: 'posts',
      label: 'Post',
      media: 'image',
      foundDaysAgo: 0,
      checkedAt: '12 min ago',
      inInbox: true,
      outcomes: { notify: 'done', collect: 'done' },
    },
    {
      id: 'd5',
      watchId: 'w-natgeo',
      kind: 'posts',
      label: 'Reel',
      media: 'video',
      foundDaysAgo: 3,
      checkedAt: '3 days ago',
      inInbox: true,
      outcomes: { notify: 'done', collect: 'done' },
    },
    {
      id: 'd6',
      watchId: 'w-natgeo',
      kind: 'posts',
      label: 'Post, 3 photos',
      media: 'sidecar',
      children: [{ id: 'c5' }, { id: 'c6', unavailable: true }, { id: 'c7' }],
      foundDaysAgo: 4,
      checkedAt: '4 days ago',
      inInbox: true,
      outcomes: { notify: 'done', collect: 'done' },
    },
    {
      id: 'd7',
      watchId: 'w-natgeo',
      kind: 'stories',
      label: 'Story',
      media: 'video',
      foundDaysAgo: 2,
      checkedAt: '2 days ago',
      unavailable: 'story-expired',
      inInbox: true,
      outcomes: { notify: 'done', collect: 'done' },
    },
    {
      id: 'd8',
      watchId: 'w-natgeo',
      kind: 'stories',
      label: 'Story',
      media: 'image',
      foundDaysAgo: 0,
      checkedAt: '12 min ago',
      inInbox: true,
      outcomes: { notify: 'failed', collect: 'done' },
      note: 'The browser did not show the notification.',
    },
    {
      id: 'd9',
      watchId: 'w-natgeo',
      kind: 'avatar',
      label: 'Avatar change',
      media: 'image',
      foundDaysAgo: 5,
      checkedAt: '5 days ago',
      unavailable: 'avatar-changed',
      inInbox: true,
      outcomes: { notify: 'done', collect: 'done' },
    },
    {
      id: 'd10',
      watchId: 'w-film',
      kind: 'stories',
      label: 'Story',
      media: 'image',
      foundDaysAgo: 27,
      checkedAt: '27 days ago',
      unavailable: 'story-expired',
      inInbox: true,
      outcomes: { collect: 'done' },
    },
    {
      id: 'd11',
      watchId: 'w-leica',
      kind: 'stories',
      label: 'Story',
      media: 'video',
      foundDaysAgo: 1,
      checkedAt: '1 day ago',
      inInbox: false,
      outcomes: { download: 'done' },
    },
  ],
};

// Mock directory for the add flow. A real add resolves the username to a stable account ID.
export const DIRECTORY: Record<string, { targetId: string; avatar: Avatar }> = {
  nasa: { targetId: '528817151', avatar: { hue: 220, initial: 'N' } },
  natgeo: { targetId: '787132', avatar: { hue: 48, initial: 'N' } },
  'kodak.film': { targetId: '1394881', avatar: 'failed' },
  fujifilm_x: { targetId: '2219034', avatar: { hue: 140, initial: 'F' } },
  leica_camera: { targetId: '30544120', avatar: { hue: 0, initial: 'L' } },
  hasselblad: { targetId: '9911', avatar: { hue: 260, initial: 'H' } },
  sonyalpha: { targetId: '4410', avatar: { hue: 300, initial: 'S' } },
  canonusa: { targetId: '5521', avatar: { hue: 10, initial: 'C' } },
};

export type Action =
  | { type: 'toggle-enabled'; watchId: string }
  | { type: 'delete'; watchId: string }
  | {
      type: 'add';
      username: string;
      kinds: ReadonlyArray<MediaKind>;
      actions: ReadonlyArray<ActionKind>;
    }
  | { type: 'toggle-kind'; watchId: string; kind: MediaKind }
  | { type: 'toggle-action'; watchId: string; action: ActionKind }
  | { type: 'retry'; discoveryId: string; action: ActionKind }
  | { type: 'resolve-uncertain'; discoveryId: string; downloaded: boolean }
  | { type: 'acknowledge'; discoveryId: string }
  | { type: 'remove-entry'; discoveryId: string }
  | { type: 'export'; discoveryIds: ReadonlyArray<string>; mode: string; rotated: boolean }
  | { type: 'scenario'; patch: Partial<Scenario> };

const mapDiscovery = (state: State, id: string, f: (d: Discovery) => Discovery): State => ({
  ...state,
  discoveries: state.discoveries.map(d => (d.id === id ? f(d) : d)),
});

const mapWatch = (state: State, id: string, f: (w: Watch) => Watch): State => ({
  ...state,
  watches: state.watches.map(w => (w.id === id ? f(w) : w)),
});

const withLog = (state: State, line: string): State => ({
  ...state,
  log: [line, ...state.log].slice(0, 8),
});

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'toggle-enabled':
      return withLog(
        mapWatch(state, action.watchId, w => ({ ...w, enabled: !w.enabled })),
        `toggled pause on ${action.watchId}, inbox and baselines kept`
      );
    case 'delete':
      return withLog(
        {
          ...state,
          watches: state.watches.filter(w => w.id !== action.watchId),
          discoveries: state.discoveries.filter(d => d.watchId !== action.watchId),
        },
        `deleted ${action.watchId}: config, seen media, inbox, pending actions. Files and History kept`
      );
    case 'add': {
      const viewer = currentViewer(state);
      const entry = DIRECTORY[action.username];
      if (!viewer || !entry) return state;
      const watch: Watch = {
        id: `w-${action.username}-${state.watches.length}`,
        ownerId: viewer.id,
        targetId: entry.targetId,
        username: action.username,
        avatar: entry.avatar,
        enabled: true,
        kinds: Object.fromEntries(action.kinds.map(k => [k, { tag: 'baseline' }])),
        actions: action.actions,
        lastCheck: 'Not yet',
      };
      return withLog(
        { ...state, watches: [watch, ...state.watches] },
        `added @${action.username} for ${viewer.username}`
      );
    }
    case 'toggle-kind':
      return mapWatch(state, action.watchId, w => {
        const current = w.kinds[action.kind];
        const next: KindHealth | undefined =
          current === undefined
            ? { tag: 'baseline' }
            : current.tag === 'off'
              ? { tag: 'ok', lastSuccess: 'catching up' }
              : current.tag === 'baseline'
                ? undefined
                : { tag: 'off' };
        const kinds = { ...w.kinds, [action.kind]: next };
        if (!next) delete kinds[action.kind];
        return { ...w, kinds };
      });
    case 'toggle-action':
      return mapWatch(state, action.watchId, w => ({
        ...w,
        actions: w.actions.includes(action.action)
          ? w.actions.filter(a => a !== action.action)
          : [...w.actions, action.action],
      }));
    case 'retry':
      return withLog(
        mapDiscovery(state, action.discoveryId, d => ({
          ...d,
          outcomes: { ...d.outcomes, [action.action]: 'done' },
          children: d.children?.map(c =>
            c.download === 'failed' ? { ...c, download: 'done' } : c
          ),
          note: undefined,
        })),
        `retried ${action.action} for exact item ${action.discoveryId}`
      );
    case 'resolve-uncertain':
      return withLog(
        mapDiscovery(state, action.discoveryId, d => ({
          ...d,
          outcomes: { ...d.outcomes, download: 'done' },
          note: undefined,
        })),
        action.downloaded
          ? `${action.discoveryId}: marked as already downloaded`
          : `${action.discoveryId}: downloaded again`
      );
    case 'acknowledge':
      return withLog(
        mapDiscovery(state, action.discoveryId, d => ({ ...d, acknowledged: true })),
        `acknowledged failure on ${action.discoveryId}, badge cleared`
      );
    case 'remove-entry':
      return withLog(
        mapDiscovery(state, action.discoveryId, d => ({ ...d, inInbox: false })),
        `removed ${action.discoveryId} from the Watch inbox`
      );
    case 'export':
      return withLog(
        state,
        `direct download of ${action.discoveryIds.length} item(s) as ${action.mode}${
          action.rotated ? ', rotated' : ''
        }, no Workspace tab opened`
      );
    case 'scenario':
      return { ...state, scenario: { ...state.scenario, ...action.patch } };
  }
}

export function usePrototypeState() {
  return useReducer(reduce, initial);
}

export type Dispatch = (action: Action) => void;
export type VariantProps = { state: State; dispatch: Dispatch };

export const currentViewer = (state: State): Viewer | null =>
  state.scenario.login === 'unverified' ? null : VIEWERS[state.scenario.login];

// Only the verified login's own Watches are visible. Others are counted, never shown.
export const visibleWatches = (state: State) => {
  const viewer = currentViewer(state);
  return viewer ? state.watches.filter(w => w.ownerId === viewer.id) : [];
};

export const hiddenWatchCount = (state: State) =>
  state.watches.length - visibleWatches(state).length;

export const watchDiscoveries = (state: State, watchId: string) =>
  state.discoveries.filter(d => d.watchId === watchId);

export const inboxEntries = (state: State) => {
  const ids = new Set(visibleWatches(state).map(w => w.id));
  return state.discoveries.filter(d => d.inInbox && ids.has(d.watchId));
};

export const openFailures = (state: State, watchId?: string) => {
  const ids = new Set(visibleWatches(state).map(w => w.id));
  return state.discoveries.filter(
    d =>
      ids.has(d.watchId) &&
      (watchId === undefined || d.watchId === watchId) &&
      !d.acknowledged &&
      Object.values(d.outcomes).some(o => o === 'failed' || o === 'uncertain')
  );
};

// Storage problems stop every kind that needs to write a new record.
export const effectiveHealth = (state: State, health: KindHealth): KindHealth =>
  state.scenario.storage !== 'ok' && health.tag !== 'off'
    ? {
        tag: 'problem',
        problem: 'storage',
        lastSuccess: health.tag === 'ok' ? health.lastSuccess : undefined,
      }
    : health;

export const kindProblems = (state: State, watch: Watch) =>
  MEDIA_KINDS.flatMap(kind => {
    const health = watch.kinds[kind];
    if (!health || !watch.enabled) return [];
    const effective = effectiveHealth(state, health);
    return effective.tag === 'problem' ? [{ kind, problem: effective.problem }] : [];
  });

export const attentionCount = (state: State) =>
  openFailures(state).length +
  visibleWatches(state).filter(w => kindProblems(state, w).length > 0).length +
  (state.scenario.storage === 'ok' ? 0 : 1);

export const storageUsed = (state: State) =>
  state.scenario.storage === 'full' ? 2.0 : state.scenario.storage === 'unreadable' ? 0 : 1.42;

export const NOTIFIED_WATCH_ID = 'w-nasa';
export const NOTIFICATION = {
  title: '@nasa',
  body: '1 new Post, 1 Instant, and an Avatar change',
};

// Export choices GramGrab ships today. An Avatar change only exports in its original form.
export const exportModesFor = (d: Discovery): ReadonlyArray<string> =>
  d.kind !== 'avatar' && d.media === 'video' ? ['Original', 'Frame', 'Silent video'] : ['Original'];

export const daysLeft = (d: Discovery) => 30 - d.foundDaysAgo;
