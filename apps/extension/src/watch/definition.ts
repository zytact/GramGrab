import { Schema } from 'effect';
import type { WatchDefinition } from '@gramgrab/protocol';
import type { Watch } from './contracts.ts';

const decodeUuid = Schema.decodeUnknownSync(Schema.UUID);

export const definitionOf = (watch: Watch): WatchDefinition => ({
  accountId: watch.targetId,
  username: watch.username,
  enabled: watch.enabled,
  kinds: watch.kinds,
  actions: watch.actions,
});

/** A new Watch of `viewerId` with no baseline, so its first check acts on nothing. */
export const newWatch = (viewerId: string, definition: WatchDefinition): Watch => ({
  id: decodeUuid(crypto.randomUUID()),
  viewerId,
  targetId: definition.accountId,
  username: definition.username,
  createdAt: Date.now(),
  enabled: definition.enabled,
  kinds: definition.kinds,
  actions: definition.actions,
  tracking: {},
  discoveries: [],
});
