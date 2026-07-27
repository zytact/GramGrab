import { connect } from 'node:net';
import { platform, userInfo } from 'node:os';
import { readFile } from 'node:fs/promises';
import { Effect, Schema } from 'effect';
import {
  CancelRequest,
  DebugExport,
  DebugGet,
  DirectExport,
  Export,
  ExportOperation,
  FrameExport,
  HistoryClear,
  HistoryList,
  HistoryRedownload,
  HistoryRemove,
  HumanItemNumber,
  Inspect,
  InstantsInspect,
  InstantsExport,
  OperationId,
  SilentExport,
  Status,
  decodeEvent,
  decodeJsonFrame,
  encodeJsonFrame,
  FrameDecoder,
  localIpcEndpoint,
  PROTOCOL_VERSION,
  Request,
  type Command,
  type EventPayload,
  type ExportMode,
  type InspectResult,
  type InstantsInspectResult,
} from '@gramgrab/protocol';

export { decodeEvent, decodeRequest, PROTOCOL_VERSION } from '@gramgrab/protocol';

export class IpcUnavailableError extends Error {
  readonly code = 'IPC_UNAVAILABLE';

  constructor(override readonly cause: unknown) {
    super(
      'IPC_UNAVAILABLE: no browser-started native host owns the endpoint. Confirm registration, keep the extension enabled, and reload the browser.'
    );
    this.name = 'IpcUnavailableError';
  }
}

const endpoint = localIpcEndpoint({
  platform: platform(),
  runtimeDirectory: process.env.XDG_RUNTIME_DIR,
  userId: platform() === 'win32' ? undefined : userInfo().uid,
  override: process.env.GRAMGRAB_IPC_PATH,
});

export interface ParsedCli {
  readonly command: Command;
  readonly json: boolean;
  readonly expandAll?: {
    readonly sourceUrl?: string;
    readonly origin: 'source' | 'instants';
    readonly mode: ExportMode;
  };
}

export const HELP = `GramGrab CLI

Usage:
  gramgrab help
  gramgrab status [--json]
  gramgrab inspect SOURCE [--json]
  gramgrab instants inspect [--json]
  gramgrab instants export [--item NUMBER ...] [--mode direct|frame|silent] [--json]
  gramgrab export SOURCE [--item NUMBER ...] [--mode direct] [--json]
  gramgrab export SOURCE [--item NUMBER ...] --mode frame [--at SECONDS] [--json]
  gramgrab export SOURCE [--item NUMBER ...] --mode silent --reencode forbid|allow|require [--json]
  gramgrab export SOURCE --plan FILE|- [--json]
  gramgrab history list|remove|clear|redownload [ENTRY_ID ...] [--json]
  gramgrab debug get|export [--json]

Sources:
  SOURCE may be an Instagram post, reel, story, highlight, or profile URL. A bare username (without
  @) targets that account's active Stories. Profile URLs resolve the account avatar.

Examples:
  gramgrab inspect instagram
  gramgrab export instagram --item 3 --mode frame --at 5

  Export defaults to every item found by a fresh inspection. Use --item to select specific items.
  Repeated --item starts another operation and may specify a different mode.

Export modes:
  direct  Download the original media. This is the default when --mode is omitted.
  frame   Export a video frame. --at defaults to 5 seconds and clamps to the video duration.
  silent  Remove audio. forbid permits stream copy only, allow permits re-encoding when needed,
          and require always permits re-encoding. JSON mode never prompts.

Plans:
  --plan reads an array of protocol ExportOperation objects from a file or stdin (-). Plans retain
  stable operation IDs and optional media identities for retries.

Output and exit status:
  --json emits compact newline-delimited progress on stderr and one terminal JSON result on stdout.
  Exit 0 means full success, 1 means rejection or a partial item failure, and 2 means invalid input
  or transport failure. History commands affect only extension-owned history. Debug export uses the
  extension's diagnostic preview and redaction policy.
`;

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

const INSTAGRAM_USERNAME = /^[a-zA-Z0-9._]{1,30}$/;

function resolveSourceUrl(value: string | undefined, message: string): string {
  const source = required(value, message);
  if (source.startsWith('-')) throw new Error(message);
  if (INSTAGRAM_USERNAME.test(source)) return `https://www.instagram.com/stories/${source}/`;
  if (URL.canParse(source)) {
    const url = new URL(source);
    if (
      /^https?:$/.test(url.protocol) &&
      ['instagram.com', 'www.instagram.com'].includes(url.hostname)
    )
      return source;
  }
  throw new Error(
    'Invalid SOURCE: expected an Instagram URL or bare username containing only letters, numbers, periods, or underscores.'
  );
}

function requiredIds(values: readonly string[]): readonly string[] {
  if (values.length === 0) throw new Error('Missing ENTRY_ID.');
  return values;
}

function itemNumber(value: string | undefined) {
  return Schema.decodeUnknownSync(HumanItemNumber)(
    Number(required(value, 'Missing --item NUMBER.'))
  );
}

function operationId() {
  return Schema.decodeUnknownSync(OperationId)(crypto.randomUUID());
}

function exportMode(arguments_: readonly string[]): ExportMode {
  const mode = option(arguments_, '--mode') ?? 'direct';
  const parsed =
    mode === 'direct'
      ? DirectExport.make({})
      : mode === 'frame'
        ? FrameExport.make({
            timestampSeconds: Number(option(arguments_, '--at') ?? '5'),
          })
        : mode === 'silent'
          ? SilentExport.make({
              reencode: Schema.decodeUnknownSync(Schema.Literal('forbid', 'allow', 'require'))(
                required(
                  option(arguments_, '--reencode'),
                  'Missing --reencode forbid|allow|require.'
                )
              ),
            })
          : undefined;
  if (!parsed) throw new Error(`Unknown export mode: ${mode}`);
  return parsed;
}

function exportOperation(arguments_: readonly string[]): ExportOperation {
  return ExportOperation.make({
    operationId: operationId(),
    itemNumber: itemNumber(option(arguments_, '--item')),
    mode: exportMode(arguments_),
  });
}

function validateInstantsArguments(arguments_: readonly string[], action: 'inspect' | 'export') {
  const valueOptions =
    action === 'inspect' ? new Set<string>() : new Set(['--item', '--mode', '--at', '--reencode']);
  for (let index = 2; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (argument === '--json') continue;
    if (!valueOptions.has(argument))
      throw new Error(`gramgrab instants ${action} does not accept a Source argument.`);
    const value = arguments_[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
  }
}

function exportCommand(arguments_: readonly string[]): ParsedCli {
  const sourceUrl = resolveSourceUrl(arguments_[1], 'Missing export SOURCE.');
  if (option(arguments_, '--plan'))
    throw new Error('Structured plans must be loaded asynchronously with --plan - or a file path.');
  const itemIndexes = arguments_.flatMap((value, index) => (value === '--item' ? [index] : []));
  if (itemIndexes.length === 0)
    return {
      command: Inspect.make({ sourceUrl }),
      json: arguments_.includes('--json'),
      expandAll: { sourceUrl, origin: 'source', mode: exportMode(arguments_) },
    };
  const operations = itemIndexes.map((start, index) =>
    exportOperation(arguments_.slice(start, itemIndexes[index + 1] ?? arguments_.length))
  );
  return {
    command: Export.make({ sourceUrl, operations }),
    json: arguments_.includes('--json'),
  };
}

// fallow-ignore-next-line complexity
export function parseCliArguments(arguments_: readonly string[]): ParsedCli {
  const json = arguments_.includes('--json');
  const command = arguments_[0] ?? 'status';
  if (command === 'status') return { command: Status.make({}), json };
  if (command === 'inspect')
    return {
      command: Inspect.make({
        sourceUrl: resolveSourceUrl(arguments_[1], 'Missing inspect SOURCE.'),
      }),
      json,
    };
  if (command === 'export') return exportCommand(arguments_);
  if (command === 'instants') {
    const action = arguments_[1];
    const instantArguments = [action ?? '', ...arguments_.slice(2)];
    if (action === 'inspect') {
      validateInstantsArguments(arguments_, action);
      return { command: InstantsInspect.make({}), json };
    }
    if (action === 'export') {
      validateInstantsArguments(arguments_, action);
      const itemIndexes = instantArguments.flatMap((value, index) =>
        value === '--item' ? [index] : []
      );
      if (itemIndexes.length === 0)
        return {
          command: InstantsInspect.make({}),
          json,
          expandAll: { origin: 'instants', mode: exportMode(instantArguments) },
        };
      return {
        command: InstantsExport.make({
          operations: itemIndexes.map((start, index) =>
            exportOperation(
              instantArguments.slice(start, itemIndexes[index + 1] ?? instantArguments.length)
            )
          ),
        }),
        json,
      };
    }
    throw new Error('Usage: gramgrab instants inspect|export');
  }
  if (command === 'history') {
    const action = arguments_[1];
    const entryIds = arguments_.slice(2).filter(value => value !== '--json');
    if (action === 'list') return { command: HistoryList.make({}), json };
    if (action === 'clear') return { command: HistoryClear.make({}), json };
    if (action === 'remove')
      return {
        command: HistoryRemove.make({
          entryIds: requiredIds(entryIds),
        }),
        json,
      };
    if (action === 'redownload')
      return {
        command: HistoryRedownload.make({
          entryIds: requiredIds(entryIds),
        }),
        json,
      };
    throw new Error('Usage: gramgrab history list|remove|clear|redownload');
  }
  if (command === 'debug') {
    if (arguments_[1] === 'get') return { command: DebugGet.make({}), json };
    if (arguments_[1] === 'export') return { command: DebugExport.make({}), json };
    throw new Error('Usage: gramgrab debug get|export');
  }
  throw new Error(`Unknown command: ${command}`);
}

async function parse(arguments_: readonly string[]): Promise<ParsedCli> {
  const plan = option(arguments_, '--plan');
  if (!plan) return parseCliArguments(arguments_);
  if (arguments_[0] !== 'export') throw new Error('--plan is only valid with export.');
  const input = plan === '-' ? await readStandardInput() : await readFile(plan, 'utf8');
  const value: unknown = JSON.parse(input);
  const sourceUrl = resolveSourceUrl(arguments_[1], 'Missing export SOURCE.');
  const command = await Effect.runPromise(
    Schema.decodeUnknown(Export)({ sourceUrl, operations: value })
  );
  return { command, json: arguments_.includes('--json') };
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeIpcConnectionError(error: unknown): unknown {
  if (!isIpcUnavailableError(error)) return error;
  return new IpcUnavailableError(error);
}

function isIpcUnavailableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'ECONNREFUSED';
}

export function request(
  command: Command,
  onEvent: (event: EventPayload) => void,
  options: {
    readonly signal?: AbortSignal;
    readonly endpoint?: string;
    readonly acceptanceTimeoutMs?: number;
    readonly terminalTimeoutMs?: number;
  } = {}
): Promise<EventPayload> {
  const requestId = crypto.randomUUID();
  const value = Schema.decodeUnknownSync(Request)({
    version: PROTOCOL_VERSION,
    requestId,
    command,
  });
  return new Promise((resolve, reject) => {
    const socket = connect(options.endpoint ?? endpoint);
    const decoder = new FrameDecoder();
    let settled = false;
    let connected = false;
    let terminalTimeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(acceptanceTimeout);
      if (terminalTimeout) clearTimeout(terminalTimeout);
      options.signal?.removeEventListener('abort', abort);
      action();
    };
    const cancel = () => {
      if (!socket.destroyed && connected)
        socket.write(
          encodeJsonFrame(
            Schema.encodeSync(CancelRequest)(
              CancelRequest.make({ version: PROTOCOL_VERSION, requestId: value.requestId })
            )
          )
        );
      if (connected) socket.end();
      else socket.destroy();
    };
    const abort = () => {
      cancel();
      finish(() => reject(new Error('Request cancelled.')));
    };
    const disconnected = () => {
      finish(() => reject(new Error('IPC disconnected before a terminal response.')));
    };
    const acceptanceTimeout = setTimeout(() => {
      socket.destroy();
      finish(() => reject(new Error('Timed out waiting for the extension.')));
    }, options.acceptanceTimeoutMs ?? 5_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    socket.on('connect', () => {
      connected = true;
      if (!settled) socket.write(encodeJsonFrame(Schema.encodeSync(Request)(value)));
    });
    socket.on('data', chunk => {
      try {
        if (typeof chunk === 'string') return socket.destroy();
        for (const frame of decoder.push(chunk)) {
          const event = Effect.runSync(decodeEvent(decodeJsonFrame(frame)));
          if (event.requestId !== requestId) continue;
          onEvent(event.event);
          if (event.event._tag === 'Accepted') {
            clearTimeout(acceptanceTimeout);
            terminalTimeout = setTimeout(
              () => {
                cancel();
                finish(() => reject(new Error('Timed out waiting for command completion.')));
              },
              options.terminalTimeoutMs ?? 30 * 60_000
            );
            continue;
          }
          if (event.event._tag === 'Progress') continue;
          socket.end();
          finish(() => resolve(event.event));
        }
      } catch (error) {
        socket.destroy();
        finish(() => reject(error));
      }
    });
    socket.on('error', error => {
      finish(() => reject(normalizeIpcConnectionError(error)));
    });
    socket.on('end', disconnected);
    socket.on('close', disconnected);
  });
}

export function createProgressPrinter(
  json: boolean,
  write: (value: string) => void = value => process.stderr.write(value)
): (event: EventPayload) => void {
  const states = new Map<string, { phase: string; milestone: number }>();
  return event => {
    if (event._tag !== 'Progress') return;
    const key = progressKey(event);
    const previous = states.get(key);
    const milestone = progressMilestone(event.progress);
    if (!shouldPrintProgress(previous, event.phase, milestone)) return;
    states.set(key, {
      phase: event.phase,
      milestone: nextProgressMilestone(previous, event.phase, milestone),
    });
    const progress = milestone < 0 ? undefined : milestone / 4;
    write(formatProgress(event, progress, json));
  };
}

function progressKey(event: Extract<EventPayload, { readonly _tag: 'Progress' }>): string {
  if (event.operationId) return event.operationId;
  return event.itemNumber ? `item:${event.itemNumber}` : 'item:batch';
}

function progressMilestone(progress: number | undefined): number {
  return progress === undefined ? -1 : Math.min(4, Math.floor(progress * 4 + 0.000_001));
}

function shouldPrintProgress(
  previous: { phase: string; milestone: number } | undefined,
  phase: string,
  milestone: number
): boolean {
  return previous?.phase !== phase || milestone > previous.milestone;
}

function nextProgressMilestone(
  previous: { phase: string; milestone: number } | undefined,
  phase: string,
  milestone: number
): number {
  return previous?.phase === phase ? Math.max(previous.milestone, milestone) : milestone;
}

function formatProgress(
  event: Extract<EventPayload, { readonly _tag: 'Progress' }>,
  progress: number | undefined,
  json: boolean
): string {
  if (!json)
    return `${event.phase}${event.itemNumber ? ` - item ${event.itemNumber}` : ''}${progress === undefined ? '' : ` - ${Math.round(progress * 100)}%`}\n`;
  return `${JSON.stringify({
    type: 'progress',
    ...(event.operationId ? { operationId: event.operationId } : {}),
    ...(event.itemNumber ? { itemNumber: event.itemNumber } : {}),
    phase: event.phase,
    ...(progress === undefined ? {} : { progress }),
  })}\n`;
}

function requestsHelp(arguments_: readonly string[]): boolean {
  return (
    ['help', '--help', '-h'].includes(arguments_[0] ?? '') ||
    arguments_.includes('--help') ||
    arguments_.includes('-h')
  );
}

function printTerminal(event: EventPayload, json: boolean): void {
  if (event._tag === 'Rejected') {
    process.stderr.write(`${JSON.stringify(event.failure)}\n`);
    process.exitCode = 1;
    return;
  }
  if (event._tag !== 'Completed') throw new Error(`Unexpected terminal event: ${event._tag}`);
  process.stdout.write(`${JSON.stringify(event.result, undefined, json ? undefined : 2)}\n`);
  if (
    event.result._tag === 'ExportResult' &&
    event.result.outcomes.some(outcome => outcome._tag !== 'ItemSucceeded')
  )
    process.exitCode = 1;
}

export async function runCli(arguments_: readonly string[], signal?: AbortSignal): Promise<void> {
  if (requestsHelp(arguments_)) {
    process.stdout.write(HELP);
    return;
  }
  const parsed = await parse(arguments_);
  const printProgress = createProgressPrinter(parsed.json);
  let event = await request(parsed.command, printProgress, {
    signal,
  });
  if (
    parsed.expandAll &&
    event._tag === 'Completed' &&
    (event.result._tag === 'InspectResult' || event.result._tag === 'InstantsInspectResult')
  ) {
    event = await request(expandedExport(parsed.expandAll, event.result), printProgress, {
      signal,
    });
  }
  printTerminal(event, parsed.json);
}

function expandedExport(
  pending: NonNullable<ParsedCli['expandAll']>,
  inspected: InspectResult | InstantsInspectResult
): Export | InstantsExport {
  if (inspected.items.length === 0) throw new Error('Inspection returned no media items.');
  const operations = inspected.items.map(item =>
    ExportOperation.make({
      operationId: operationId(),
      itemNumber: item.itemNumber,
      mediaIdentity: item.mediaIdentity,
      mode: pending.mode,
    })
  );
  return pending.origin === 'instants'
    ? InstantsExport.make({ operations })
    : Export.make({ sourceUrl: pending.sourceUrl!, operations });
}

if (import.meta.main) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  runCli(process.argv.slice(2), controller.signal).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      process.argv.includes('--json')
        ? `${JSON.stringify({ type: 'error', message })}\n`
        : `${message}\n`
    );
    process.exitCode = 2;
  });
}
