import { Schema } from 'effect';
import {
  DirectExport,
  FrameExport,
  SilentExport,
  Rotation,
  WatchInboxList,
  WatchInboxRemove,
  WatchInboxExport,
  WatchInboxRetry,
  type WatchCommand,
  type WatchSelector,
  type ExportMode,
} from '@gramgrab/protocol';
import type { WatchArguments } from './watch.ts';

function validateModeOptions(values: ReadonlyMap<string, string>, mode: string) {
  if (values.has('--at') && mode !== 'frame') throw new Error('--at requires --mode frame.');
  if (values.has('--reencode') && mode !== 'silent')
    throw new Error('--reencode requires --mode silent.');
}

function exportMode(values: ReadonlyMap<string, string>): ExportMode {
  const mode = values.get('--mode') ?? 'direct';
  validateModeOptions(values, mode);
  if (mode === 'direct') return DirectExport.make();
  if (mode === 'frame')
    return FrameExport.make({ timestampSeconds: Number(values.get('--at') ?? '5') });
  if (mode === 'silent')
    return SilentExport.make({
      reencode: Schema.decodeUnknownSync(Schema.Literal('forbid', 'allow', 'require'))(
        values.get('--reencode')
      ),
    });
  throw new Error(`Unknown export mode: ${mode}`);
}

function exportEntries(ids: readonly string[], values: ReadonlyMap<string, string>): WatchCommand {
  if (values.has('--recovery')) throw new Error('--recovery requires inbox retry.');
  const rotation = values.has('--rotate')
    ? Schema.decodeUnknownSync(Rotation)(Number(values.get('--rotate')))
    : undefined;
  return WatchInboxExport.make({
    entryIds: ids,
    settings: { mode: exportMode(values), ...(rotation ? { rotation } : {}) },
  });
}

function retryEntries(ids: readonly string[], values: ReadonlyMap<string, string>): WatchCommand {
  if ([...values.keys()].some(key => key !== '--recovery') || ids.length % 2)
    throw new Error(
      'Usage: gramgrab watch inbox retry ENTRY_ID PLAN_ID ... [--recovery original|reencode].'
    );
  const plans = ids.flatMap((entryId, index) =>
    index % 2 === 0
      ? [{ entryId, planId: Schema.decodeUnknownSync(Schema.UUID)(ids[index + 1]) }]
      : []
  );
  const recovery = values.has('--recovery')
    ? Schema.decodeUnknownSync(Schema.Literal('original', 'reencode'))(values.get('--recovery'))
    : undefined;
  return WatchInboxRetry.make({ plans, ...(recovery ? { recovery } : {}) });
}

function listInbox(
  parsed: WatchArguments,
  select: (value: string, flags: ReadonlySet<string>) => WatchSelector
): WatchCommand {
  const [, ...ids] = parsed.positionals;
  if (ids.length > 1 || parsed.values.size)
    throw new Error('Usage: gramgrab watch inbox list [WATCH].');
  if (!ids.length && (parsed.flags.has('--account-id') || parsed.flags.has('--username')))
    throw new Error('A selector override needs a WATCH.');
  return WatchInboxList.make(ids[0] ? { watch: select(ids[0], parsed.flags) } : {});
}

export function parseWatchInbox(
  parsed: WatchArguments,
  select: (value: string, flags: ReadonlySet<string>) => WatchSelector
): WatchCommand {
  const [action, ...ids] = parsed.positionals;
  if (action === 'list') return listInbox(parsed, select);
  if (parsed.flags.has('--account-id') || parsed.flags.has('--username'))
    throw new Error('Inbox entry IDs do not take selector overrides.');
  if (!ids.length) throw new Error('Inbox remove, export, or retry needs ENTRY_IDs.');
  if (action === 'export') return exportEntries(ids, parsed.values);
  if (action === 'retry') return retryEntries(ids, parsed.values);
  if (action !== 'remove') throw new Error('Usage: gramgrab watch inbox list|remove|export|retry.');
  if (parsed.values.size) throw new Error('Inbox remove takes no Export options.');
  return WatchInboxRemove.make({ entryIds: ids });
}
