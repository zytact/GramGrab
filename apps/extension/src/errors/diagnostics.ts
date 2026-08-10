import { Schema } from 'effect';
import type { AttemptOutcome, DownloadAttempt } from '../download/attempt.ts';
import {
  FailurePhaseSchema,
  FailureCodeSchema,
  SkipCodeSchema,
  WarningCodeSchema,
} from './contracts.ts';
import {
  WhatsAppStructuralEvidence,
  type OperationFailure,
  type OperationWarning,
} from './contracts.ts';

const BrowserFamilySchema = Schema.Literal('chromium', 'firefox', 'safari', 'unknown');
const PlatformFamilySchema = Schema.Literal(
  'android',
  'chromeos',
  'ios',
  'linux',
  'macos',
  'unknown',
  'windows'
);

class DiagnosticsBrowser extends Schema.Class<DiagnosticsBrowser>('DiagnosticsBrowser')({
  family: BrowserFamilySchema,
  majorVersion: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  platform: PlatformFamilySchema,
}) {}

const SignatureParameterPresenceSchema = Schema.Struct({
  _nc_cat: Schema.Boolean,
  _nc_ohc: Schema.Boolean,
  _nc_sid: Schema.Boolean,
  ccb: Schema.Boolean,
  efg: Schema.Boolean,
  oh: Schema.Boolean,
  oe: Schema.Boolean,
  se: Schema.Boolean,
  st: Schema.Boolean,
});
type SignatureParameterPresence = Schema.Schema.Type<typeof SignatureParameterPresenceSchema>;

class ParsedMediaUrlDescriptor extends Schema.Class<ParsedMediaUrlDescriptor>(
  'ParsedMediaUrlDescriptor'
)({
  parseStatus: Schema.Literal('parsed'),
  hostname: Schema.String.pipe(Schema.nonEmptyString()),
  pathSegmentCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  pathExtension: Schema.NullOr(Schema.String),
  queryParameterNames: Schema.Array(Schema.String.pipe(Schema.nonEmptyString())),
  signatureParameters: SignatureParameterPresenceSchema,
  expiresAt: Schema.NullOr(Schema.String),
  expiredAtCapture: Schema.NullOr(Schema.Boolean),
}) {}

class InvalidMediaUrlDescriptor extends Schema.Class<InvalidMediaUrlDescriptor>(
  'InvalidMediaUrlDescriptor'
)({
  parseStatus: Schema.Literal('invalid'),
}) {}

const MediaUrlDescriptor = Schema.Union(ParsedMediaUrlDescriptor, InvalidMediaUrlDescriptor);
type MediaUrlDescriptor = Schema.Schema.Type<typeof MediaUrlDescriptor>;

class DiagnosticsFailure extends Schema.Class<DiagnosticsFailure>('DiagnosticsFailure')({
  code: FailureCodeSchema,
  phase: FailurePhaseSchema,
  scope: Schema.Literal('batch', 'item'),
}) {}

class DiagnosticsWarning extends Schema.Class<DiagnosticsWarning>('DiagnosticsWarning')({
  code: WarningCodeSchema,
}) {}

const DiagnosticsOutcome = Schema.Union(
  Schema.Struct({ status: Schema.Literal('pending') }),
  Schema.Struct({
    status: Schema.Literal('started'),
    warning: Schema.optionalWith(DiagnosticsWarning, { exact: true }),
  }),
  Schema.Struct({ status: Schema.Literal('failed'), failure: DiagnosticsFailure }),
  Schema.Struct({ status: Schema.Literal('skipped'), skipCode: SkipCodeSchema }),
  Schema.Struct({ status: Schema.Literal('not-attempted') })
);
type DiagnosticsOutcome = Schema.Schema.Type<typeof DiagnosticsOutcome>;

class DiagnosticsItem extends Schema.Class<DiagnosticsItem>('DiagnosticsItem')({
  mediaType: Schema.Literal('image', 'video'),
  mediaUrl: MediaUrlDescriptor,
  executionCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  manualRetryCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  outcome: DiagnosticsOutcome,
}) {}

const DiagnosticsAttemptEntry = Schema.Struct({
  executionCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  manualRetryCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

class DiagnosticsAttempt extends Schema.Class<DiagnosticsAttempt>('DiagnosticsAttempt')({
  entries: Schema.Array(DiagnosticsAttemptEntry),
}) {}

class InstagramDiagnosticsReport extends Schema.Class<InstagramDiagnosticsReport>(
  'InstagramDiagnosticsReport'
)({
  diagnosticsVersion: Schema.Literal(2),
  platform: Schema.Literal('instagram'),
  capturedAt: Schema.String.pipe(Schema.nonEmptyString()),
  extensionVersion: Schema.String.pipe(Schema.nonEmptyString()),
  browser: DiagnosticsBrowser,
  attempt: DiagnosticsAttempt,
  batchFailure: Schema.optionalWith(DiagnosticsFailure, { exact: true }),
  items: Schema.Array(DiagnosticsItem),
  warnings: Schema.Array(DiagnosticsWarning),
}) {}

class WhatsAppDiagnosticFailure extends Schema.Class<WhatsAppDiagnosticFailure>(
  'WhatsAppDiagnosticFailure'
)({
  code: FailureCodeSchema,
  phase: FailurePhaseSchema,
  scope: Schema.Literal('item'),
}) {}

class WhatsAppDiagnosticsReport extends Schema.Class<WhatsAppDiagnosticsReport>(
  'WhatsAppDiagnosticsReport'
)({
  diagnosticsVersion: Schema.Literal(2),
  platform: Schema.Literal('whatsapp'),
  capturedAt: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  extensionVersion: Schema.String.pipe(Schema.pattern(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u)),
  browser: DiagnosticsBrowser,
  failure: WhatsAppDiagnosticFailure,
  evidence: WhatsAppStructuralEvidence,
}) {}

export const DiagnosticsReport = Schema.Union(
  InstagramDiagnosticsReport,
  WhatsAppDiagnosticsReport
);

const EXPIRY_PARAMETERS = ['oe', 'se', 'expires', 'expires_at', 'exp'] as const;

type ParsedExpiry = {
  readonly date: Date;
  readonly timestamp: string;
};

function parseUnixSeconds(value: string, radix: 10 | 16): Date | undefined {
  if (radix === 16 ? !/^[0-9a-f]+$/i.test(value) : !/^\d+$/.test(value)) return undefined;
  const seconds = Number.parseInt(value, radix);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseExpiryValue(parameter: string, value: string): Date | undefined {
  if (parameter === 'oe') return parseUnixSeconds(value, 16) ?? parseUnixSeconds(value, 10);
  return parseUnixSeconds(value, 10);
}

function parseExpiry(parameters: ReadonlyMap<string, readonly string[]>): ParsedExpiry | undefined {
  for (const parameter of EXPIRY_PARAMETERS) {
    for (const value of parameters.get(parameter) ?? []) {
      const date = parseExpiryValue(parameter, value);
      if (date) return { date, timestamp: date.toISOString() };
    }
  }
  return undefined;
}

function normalizedQueryParameters(url: URL): ReadonlyMap<string, readonly string[]> {
  const parameters = new Map<string, string[]>();
  for (const [name, value] of url.searchParams.entries()) {
    const normalizedName = name.toLowerCase();
    const values = parameters.get(normalizedName) ?? [];
    values.push(value);
    parameters.set(normalizedName, values);
  }
  return parameters;
}

function pathExtension(url: URL): string | null {
  const segment = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  const dotIndex = segment.lastIndexOf('.');
  if (dotIndex <= 0) return null;
  const extension = segment.slice(dotIndex + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(extension) ? extension : null;
}

function signatureParameterPresence(
  parameters: ReadonlyMap<string, readonly string[]>
): SignatureParameterPresence {
  return {
    _nc_cat: parameters.has('_nc_cat'),
    _nc_ohc: parameters.has('_nc_ohc'),
    _nc_sid: parameters.has('_nc_sid'),
    ccb: parameters.has('ccb'),
    efg: parameters.has('efg'),
    oh: parameters.has('oh'),
    oe: parameters.has('oe'),
    se: parameters.has('se'),
    st: parameters.has('st'),
  };
}

function describeMediaUrl(value: string, capturedAt: Date): MediaUrlDescriptor {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      return InvalidMediaUrlDescriptor.make({ parseStatus: 'invalid' });
    }
    const parameters = normalizedQueryParameters(url);
    const expiry = parseExpiry(parameters);
    return ParsedMediaUrlDescriptor.make({
      parseStatus: 'parsed',
      hostname: url.hostname.toLowerCase().replace(/\.$/, ''),
      pathSegmentCount: url.pathname.split('/').filter(Boolean).length,
      pathExtension: pathExtension(url),
      queryParameterNames: [...parameters.keys()].sort(),
      signatureParameters: signatureParameterPresence(parameters),
      expiresAt: expiry?.timestamp ?? null,
      expiredAtCapture: expiry ? expiry.date.getTime() <= capturedAt.getTime() : null,
    });
  } catch {
    return InvalidMediaUrlDescriptor.make({ parseStatus: 'invalid' });
  }
}

function majorVersion(userAgent: string, pattern: RegExp): number | null {
  const match = pattern.exec(userAgent);
  if (!match?.[1]) return null;
  const version = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}

type BrowserDescriptorParts = {
  readonly family: Schema.Schema.Type<typeof BrowserFamilySchema>;
  readonly majorVersion: number | null;
};

function browserDescriptor(userAgent: string): BrowserDescriptorParts {
  const chromiumMajorVersion =
    majorVersion(userAgent, /Edg\/(\d+)/i) ??
    majorVersion(userAgent, /OPR\/(\d+)/i) ??
    majorVersion(userAgent, /Chrome\/(\d+)/i) ??
    majorVersion(userAgent, /Chromium\/(\d+)/i);
  if (chromiumMajorVersion !== null) {
    return { family: 'chromium', majorVersion: chromiumMajorVersion };
  }

  const firefoxMajorVersion = majorVersion(userAgent, /Firefox\/(\d+)/i);
  if (firefoxMajorVersion !== null) return { family: 'firefox', majorVersion: firefoxMajorVersion };

  const safariMajorVersion = /Version\/(\d+).*Safari\//i.test(userAgent)
    ? majorVersion(userAgent, /Version\/(\d+)/i)
    : null;
  if (safariMajorVersion !== null) return { family: 'safari', majorVersion: safariMajorVersion };

  return { family: 'unknown', majorVersion: null };
}

function platformFamily(userAgent: string): Schema.Schema.Type<typeof PlatformFamilySchema> {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/CrOS/i.test(userAgent)) return 'chromeos';
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux/i.test(userAgent)) return 'linux';
  return 'unknown';
}

function describeUserAgent(userAgent: string): DiagnosticsBrowser {
  return DiagnosticsBrowser.make({
    ...browserDescriptor(userAgent),
    platform: platformFamily(userAgent),
  });
}

function diagnosticsFailure(failure: OperationFailure): DiagnosticsFailure {
  return DiagnosticsFailure.make({
    code: failure.code,
    phase: failure.phase,
    scope: failure.scope,
  });
}

function diagnosticsWarning(warning: OperationWarning): DiagnosticsWarning {
  return DiagnosticsWarning.make({ code: warning.code });
}

function diagnosticsOutcome(outcome: AttemptOutcome): DiagnosticsOutcome {
  switch (outcome.status) {
    case 'pending':
      return { status: 'pending' };
    case 'started':
      return outcome.warning
        ? { status: 'started', warning: diagnosticsWarning(outcome.warning) }
        : { status: 'started' };
    case 'failed':
      return { status: 'failed', failure: diagnosticsFailure(outcome.failure) };
    case 'skipped':
      return { status: 'skipped', skipCode: outcome.code };
    case 'not-attempted':
      return { status: 'not-attempted' };
  }
}

export interface DiagnosticsInput {
  readonly extensionVersion: string;
  readonly userAgent: string;
  readonly sourceUrl?: string;
  readonly attempt?: DownloadAttempt;
  readonly batchFailure?: OperationFailure;
}

export function makeDiagnostics(
  input: DiagnosticsInput,
  capturedAt = new Date()
): InstagramDiagnosticsReport {
  const entries = input.attempt?.entries ?? [];
  const batchFailure = input.batchFailure ?? input.attempt?.batchFailure;
  return InstagramDiagnosticsReport.make({
    diagnosticsVersion: 2,
    platform: 'instagram',
    capturedAt: capturedAt.toISOString(),
    extensionVersion: input.extensionVersion,
    browser: describeUserAgent(input.userAgent),
    attempt: DiagnosticsAttempt.make({
      entries: entries.map(entry => ({
        executionCount: entry.executionCount,
        manualRetryCount: entry.manualRetryCount,
      })),
    }),
    ...(batchFailure ? { batchFailure: diagnosticsFailure(batchFailure) } : {}),
    items: entries.map(entry =>
      DiagnosticsItem.make({
        mediaType: entry.operation.mediaType,
        mediaUrl: describeMediaUrl(entry.operation.url, capturedAt),
        executionCount: entry.executionCount,
        manualRetryCount: entry.manualRetryCount,
        outcome: diagnosticsOutcome(entry.outcome),
      })
    ),
    warnings: entries.flatMap(entry =>
      entry.outcome.status === 'started' && entry.outcome.warning
        ? [diagnosticsWarning(entry.outcome.warning)]
        : []
    ),
  });
}

export function makeWhatsAppDiagnostics(
  input: Pick<DiagnosticsInput, 'extensionVersion' | 'userAgent'> & {
    readonly failure: OperationFailure;
  },
  capturedAt = new Date()
): WhatsAppDiagnosticsReport {
  if (input.failure.platform !== 'whatsapp')
    throw new Error('WhatsApp diagnostics require structural WhatsApp evidence');
  const evidence = input.failure.structuralEvidence;
  return WhatsAppDiagnosticsReport.make({
    diagnosticsVersion: 2,
    platform: 'whatsapp',
    capturedAt: capturedAt.getTime(),
    extensionVersion: input.extensionVersion,
    browser: describeUserAgent(input.userAgent),
    failure: WhatsAppDiagnosticFailure.make({
      code: input.failure.code,
      phase: input.failure.phase,
      scope: 'item',
    }),
    evidence,
  });
}

function encodeDiagnostics(report: Schema.Schema.Type<typeof DiagnosticsReport>): string {
  return JSON.stringify(Schema.encodeUnknownSync(DiagnosticsReport)(report), null, 2);
}

export function buildDiagnostics(input: DiagnosticsInput, capturedAt = new Date()): string {
  return encodeDiagnostics(makeDiagnostics(input, capturedAt));
}

export function buildWhatsAppDiagnostics(
  input: Pick<DiagnosticsInput, 'extensionVersion' | 'userAgent'> & {
    readonly failure: OperationFailure;
  },
  capturedAt = new Date()
): string {
  return encodeDiagnostics(makeWhatsAppDiagnostics(input, capturedAt));
}

export const decodeDiagnostics = (value: unknown) =>
  Schema.decodeUnknownEither(DiagnosticsReport, { onExcessProperty: 'error' })(value);
