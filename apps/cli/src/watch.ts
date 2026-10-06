import { parseWatchInbox } from './watch-inbox.ts';
import { Schema } from 'effect';
import {
  AccountId,
  AccountIdSelector,
  InstagramUsername,
  UsernameSelector,
  WatchActions,
  WatchAdd,
  WatchCheck,
  WatchNeeds,
  WatchAttentionRecover,
  WatchKinds,
  WatchLifecycle,
  WatchList,
  WatchRecover,
  WatchSet,
  WatchShow,
  type WatchCommand,
  type WatchSelector,
} from '@gramgrab/protocol';

const FLAGS = new Set(['--json', '--accept-unattended', '--account-id', '--username', '--all']);
const VALUE_FLAGS = new Set([
  '--kinds',
  '--actions',
  '--mode',
  '--at',
  '--reencode',
  '--rotate',
  '--recovery',
]);

export interface WatchArguments {
  readonly positionals: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

function split(arguments_: readonly string[]): WatchArguments {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (FLAGS.has(argument)) flags.add(argument);
    else if (VALUE_FLAGS.has(argument)) {
      const value = arguments_[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      values.set(argument, value);
    } else if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
    else positionals.push(argument);
  }
  return { positionals, flags, values };
}

const decodeAccountId = Schema.decodeUnknownSync(AccountId);
const decodeUsername = Schema.decodeUnknownSync(InstagramUsername);

/**
 * Reads a WATCH selector. All digits mean an account ID unless --username forces a username;
 * --account-id forces an account ID.
 */
function selector(value: string, flags: ReadonlySet<string>): WatchSelector {
  const asAccountId = flags.has('--account-id');
  const asUsername = flags.has('--username');
  if (asAccountId && asUsername) throw new Error('Use either --account-id or --username.');
  const username = value.replace(/^@/, '');
  try {
    if (asAccountId || (!asUsername && /^\d+$/.test(value)))
      return AccountIdSelector.make({ accountId: decodeAccountId(value) });
    return UsernameSelector.make({ username: decodeUsername(username) });
  } catch {
    throw new Error(`Invalid WATCH: ${value}`);
  }
}

function list<A, I>(
  values: ReadonlyMap<string, string>,
  name: '--kinds' | '--actions',
  schema: Schema.Schema<A, I>
): A | undefined {
  const value = values.get(name);
  if (value === undefined) return undefined;
  try {
    return Schema.decodeUnknownSync(schema)(value.split(',').map(item => item.trim()));
  } catch {
    throw new Error(
      name === '--kinds'
        ? 'Invalid --kinds: use posts, stories, instants, or avatar, each once.'
        : 'Invalid --actions: use notify, download, or collect, each once.'
    );
  }
}

function one(positionals: readonly string[], name: string): string {
  if (positionals.length !== 1) throw new Error(`Expected exactly one ${name}.`);
  return positionals[0]!;
}

const parsers: Record<string, (parsed: WatchArguments) => WatchCommand> = {
  needs: ({ positionals }) => {
    if (positionals.length) throw new Error('gramgrab watch needs takes no IDs.');
    return WatchNeeds.make();
  },
  inbox: parsed => parseWatchInbox(parsed, selector),
  ...Object.fromEntries(
    (['retry', 'dismiss', 'confirm'] as const).map(operation => [
      operation,
      ({ positionals }: WatchArguments) => {
        if (!positionals.length)
          throw new Error(`gramgrab watch ${operation} needs ATTENTION_IDs.`);
        return WatchAttentionRecover.make({ operation, attentionIds: positionals });
      },
    ])
  ),
  list: ({ positionals }) => {
    if (positionals.length > 0) throw new Error('gramgrab watch list takes no WATCH.');
    return WatchList.make();
  },
  show: ({ positionals, flags }) =>
    WatchShow.make({ watch: selector(one(positionals, 'WATCH'), flags) }),
  add: ({ positionals, flags, values }) => {
    const kinds = list(values, '--kinds', WatchKinds);
    const actions = list(values, '--actions', WatchActions);
    if (!kinds || !actions) throw new Error('gramgrab watch add needs --kinds and --actions.');
    return WatchAdd.make({
      target: one(positionals, 'TARGET'),
      kinds,
      actions,
      acceptUnattended: flags.has('--accept-unattended'),
    });
  },
  set: ({ positionals, flags, values }) => {
    const kinds = list(values, '--kinds', WatchKinds);
    const actions = list(values, '--actions', WatchActions);
    if (!kinds && !actions) throw new Error('gramgrab watch set needs --kinds or --actions.');
    return WatchSet.make({
      watch: selector(one(positionals, 'WATCH'), flags),
      ...(kinds ? { kinds } : {}),
      ...(actions ? { actions } : {}),
    });
  },
  check: ({ positionals, flags, values }) => {
    if (values.size || flags.has('--accept-unattended'))
      throw new Error('Invalid options for watch check.');
    if (flags.has('--all')) {
      if (positionals.length || flags.has('--account-id') || flags.has('--username'))
        throw new Error('Use WATCH selectors or --all, not both.');
      return WatchCheck.make({});
    }
    const watches = positionals.map(value => selector(value, flags));
    if (!watches.length) throw new Error('gramgrab watch check needs WATCH selectors or --all.');
    return WatchCheck.make({ watches });
  },
  recover: ({ positionals }) => {
    const [action, operation, ...entryIds] = positionals;
    if (action !== 'notify' || (operation !== 'retry' && operation !== 'dismiss'))
      throw new Error('Usage: gramgrab watch recover notify retry|dismiss ENTRY_ID ...');
    const [first, ...rest] = entryIds;
    if (!first) throw new Error('gramgrab watch recover needs at least one ENTRY_ID.');
    return WatchRecover.make({ action, operation, entryIds: [first, ...rest] });
  },
  ...Object.fromEntries(
    (['pause', 'resume', 'delete'] as const).map(operation => [
      operation,
      ({ positionals, flags }: WatchArguments) => {
        const [first, ...rest] = positionals.map(value => selector(value, flags));
        if (!first) throw new Error(`gramgrab watch ${operation} needs at least one WATCH.`);
        return WatchLifecycle.make({ operation, watches: [first, ...rest] });
      },
    ])
  ),
};

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  list: ['--json'],
  needs: ['--json'],
  retry: ['--json'],
  dismiss: ['--json'],
  confirm: ['--json'],
  inbox: [
    '--json',
    '--account-id',
    '--username',
    '--mode',
    '--at',
    '--reencode',
    '--rotate',
    '--recovery',
  ],
  show: ['--json', '--account-id', '--username'],
  add: ['--json', '--accept-unattended', '--kinds', '--actions'],
  set: ['--json', '--account-id', '--username', '--kinds', '--actions'],
  pause: ['--json', '--account-id', '--username'],
  resume: ['--json', '--account-id', '--username'],
  delete: ['--json', '--account-id', '--username'],
  check: ['--json', '--all', '--account-id', '--username'],
  recover: ['--json'],
};

/** Parses `gramgrab watch ACTION ...` after the `watch` word. */
export function parseWatchArguments(arguments_: readonly string[]): WatchCommand {
  const action = arguments_[0] ?? '';
  const parse = Object.hasOwn(parsers, action) ? parsers[action] : undefined;
  if (!parse)
    throw new Error(
      'Usage: gramgrab watch list|show|add|set|pause|resume|delete|check|needs|retry|dismiss|confirm|inbox'
    );
  const parsed = split(arguments_.slice(1));
  const unknown = [...parsed.flags, ...parsed.values.keys()].find(
    option => !ALLOWED[action]?.includes(option)
  );
  if (unknown) throw new Error(`Unknown option for watch ${action}: ${unknown}`);
  return parse(parsed);
}
