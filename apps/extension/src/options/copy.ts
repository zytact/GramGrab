import type { WatchAction, WatchKind } from '@gramgrab/protocol';

export const WATCH_AVATAR_NOTE =
  'Initials stand in for pictures. Pictures update during Watch checks.';

export const KIND_LABEL: Record<WatchKind, string> = {
  posts: 'Posts',
  stories: 'Stories',
  instants: 'Instants',
  avatar: 'Avatar changes',
};

/** Coverage limits, shown wherever a person picks a kind. */
export const KIND_NOTE: Record<WatchKind, string> = {
  posts:
    'Includes Reels. Posts published before the Watch began never count, even if they reappear.',
  stories: 'Only Stories still active when a check runs. Highlights are not watched.',
  instants:
    'Only Instants in your own Instants feed when a check runs. Ones that already left it cannot be found.',
  avatar: 'Any new picture counts, even a re-upload of the same-looking image.',
};

export const ACTION_LABEL: Record<WatchAction, string> = {
  notify: 'Notify me',
  download: 'Download automatically',
  collect: 'Collect in Watch inbox',
};

export const ACTION_NOTE: Record<WatchAction, string> = {
  notify: 'One summary per check, with the account Avatar as the icon.',
  download:
    'Original files only, named like other GramGrab downloads. Chromium may still ask where to save.',
  collect: 'Keeps new media for 30 days so you can choose how to download it later.',
};

export function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
