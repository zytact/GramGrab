import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Effect, Either, Layer, Schema } from 'effect';
import {
  HdAvatarResponseSchema,
  HighlightsTrayResponseSchema,
  InstantsFeedResponseSchema,
  ReelsMediaResponseSchema,
  ShortcodeMediaResponseSchema,
  WebProfileInfoResponseSchema,
} from '../../src/effect/schemas.ts';
import { isJsonValue, sanitizeBatch, type SanitizerViolation } from './sanitize.ts';
import { FIXTURE_FILENAMES, isFixtureFilename, type FixtureFilename } from './policy.ts';
import type { JsonValue } from './entities.ts';

interface SafeDiagnostic {
  readonly filename: string;
  readonly path: string;
  readonly expected: string;
  readonly observed: string;
  readonly category: string;
}

const SafeDiagnosticSchema = Schema.Struct({
  filename: Schema.String,
  path: Schema.String,
  expected: Schema.String,
  observed: Schema.String,
  category: Schema.String,
});

export class FileSystemError extends Schema.TaggedError<FileSystemError>()('FileSystemError', {
  operation: Schema.String,
  path: Schema.String,
  category: Schema.String,
}) {}

class BatchValidationError extends Schema.TaggedError<BatchValidationError>()(
  'BatchValidationError',
  { diagnostics: Schema.Array(SafeDiagnosticSchema) }
) {}

class EndpointSchemaError extends Schema.TaggedError<EndpointSchemaError>()('EndpointSchemaError', {
  filename: Schema.String,
}) {}

class TransactionError extends Schema.TaggedError<TransactionError>()('TransactionError', {
  operation: Schema.String,
  path: Schema.String,
  category: Schema.String,
}) {}

export type WorkflowError = BatchValidationError | FileSystemError | TransactionError;

export interface FixtureFileSystemShape {
  readonly copy: (source: string, destination: string) => Effect.Effect<void, FileSystemError>;
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly makeDirectory: (path: string) => Effect.Effect<void, FileSystemError>;
  readonly readDirectory: (path: string) => Effect.Effect<ReadonlyArray<string>, FileSystemError>;
  readonly readText: (path: string) => Effect.Effect<string, FileSystemError>;
  readonly remove: (path: string) => Effect.Effect<void, FileSystemError>;
  readonly rename: (source: string, destination: string) => Effect.Effect<void, FileSystemError>;
  readonly writeText: (path: string, contents: string) => Effect.Effect<void, FileSystemError>;
}

export class FixtureFileSystem extends Context.Tag('FixtureFileSystem')<
  FixtureFileSystem,
  FixtureFileSystemShape
>() {}

const categoryOf = (cause: unknown): string =>
  cause instanceof Error ? cause.name : 'UnknownError';

const fsFailure =
  (operation: string, path: string) =>
  (cause: unknown): FileSystemError =>
    FileSystemError.make({ operation, path, category: categoryOf(cause) });

export const fixtureFileSystemLive: FixtureFileSystemShape = {
  copy: (source, destination) =>
    Effect.tryPromise({
      try: () => cp(source, destination, { recursive: true }),
      catch: fsFailure('copy', destination),
    }),
  exists: path =>
    Effect.promise(async () => {
      try {
        await readdir(path);
        return true;
      } catch {
        try {
          await readFile(path);
          return true;
        } catch {
          return false;
        }
      }
    }),
  makeDirectory: path =>
    Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }).then(() => undefined),
      catch: fsFailure('mkdir', path),
    }),
  readDirectory: path =>
    Effect.tryPromise({
      try: () => readdir(path),
      catch: fsFailure('readdir', path),
    }),
  readText: path =>
    Effect.tryPromise({
      try: () => readFile(path, 'utf8'),
      catch: fsFailure('read', path),
    }),
  remove: path =>
    Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: fsFailure('remove', path),
    }),
  rename: (source, destination) =>
    Effect.tryPromise({
      try: () => rename(source, destination),
      catch: fsFailure('rename', destination),
    }),
  writeText: (path, contents) =>
    Effect.tryPromise({
      try: () => writeFile(path, contents, 'utf8'),
      catch: fsFailure('write', path),
    }),
};

export const FixtureFileSystemLive = Layer.succeed(FixtureFileSystem)(fixtureFileSystemLive);

export interface WorkflowPaths {
  readonly raw: string;
  readonly staging: string;
  readonly destination: string;
}

interface WorkflowOptions {
  readonly paths: WorkflowPaths;
  readonly write: boolean;
}

interface WorkflowResult {
  readonly fileCount: number;
  readonly installed: boolean;
  readonly stagingPath: string;
}

const batchContractDiagnostics = (
  entries: ReadonlyArray<string>
): ReadonlyArray<SafeDiagnostic> => {
  const actual = new Set(entries);
  const diagnostics: Array<SafeDiagnostic> = [];
  for (const filename of FIXTURE_FILENAMES) {
    if (!actual.has(filename)) {
      diagnostics.push({
        filename,
        path: '',
        expected: 'required fixture file',
        observed: 'missing',
        category: 'batch-contract',
      });
    }
  }
  for (const entry of entries) {
    if (!isFixtureFilename(entry)) {
      diagnostics.push({
        filename: entry,
        path: '',
        expected: 'one of the required fixture files',
        observed: 'unexpected entry',
        category: 'batch-contract',
      });
    }
  }
  return diagnostics;
};

const parseFixture = Effect.fn('parseFixture')(function* (filename: FixtureFilename, text: string) {
  const parsed = yield* Schema.decodeUnknown(Schema.parseJson())(text).pipe(
    Effect.mapError(() =>
      BatchValidationError.make({
        diagnostics: [
          {
            filename,
            path: '',
            expected: 'valid JSON value',
            observed: 'invalid JSON',
            category: 'json-boundary',
          },
        ],
      })
    )
  );
  if (!isJsonValue(parsed)) {
    return yield* BatchValidationError.make({
      diagnostics: [
        {
          filename,
          path: '',
          expected: 'finite JSON value',
          observed: 'invalid JSON value',
          category: 'json-boundary',
        },
      ],
    });
  }
  return parsed;
});

const sanitizerDiagnostics = (
  violations: ReadonlyArray<SanitizerViolation>
): ReadonlyArray<SafeDiagnostic> => violations.map(violation => violation);

const endpointFailure = (filename: FixtureFilename) => () => EndpointSchemaError.make({ filename });
const endpointDecoder =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (value: unknown) =>
    Schema.decodeUnknown(schema)(value).pipe(Effect.asVoid);

const endpointDecoders = {
  'avatar.json': endpointDecoder(HdAvatarResponseSchema),
  'highlights-tray.json': endpointDecoder(HighlightsTrayResponseSchema),
  'highlights.json': endpointDecoder(ReelsMediaResponseSchema),
  'story.json': endpointDecoder(ReelsMediaResponseSchema),
  'instants-photo.json': endpointDecoder(InstantsFeedResponseSchema),
  'instants-video.json': endpointDecoder(InstantsFeedResponseSchema),
  'instants-empty.json': endpointDecoder(InstantsFeedResponseSchema),
  'shortcode-image.json': endpointDecoder(ShortcodeMediaResponseSchema),
  'shortcode-sidecar.json': endpointDecoder(ShortcodeMediaResponseSchema),
  'shortcode-video.json': endpointDecoder(ShortcodeMediaResponseSchema),
  'web-profile-info.json': endpointDecoder(WebProfileInfoResponseSchema),
};

const validateEndpoint = (
  filename: FixtureFilename,
  value: JsonValue
): Effect.Effect<void, EndpointSchemaError> =>
  endpointDecoders[filename](value).pipe(Effect.mapError(endpointFailure(filename)));

const isPrimitive = (value: JsonValue): value is boolean | number | string | null =>
  value === null || typeof value !== 'object';

const serializeJson = (value: JsonValue, depth: number): string => {
  if (isPrimitive(value)) return JSON.stringify(value);
  const indentation = ' '.repeat(depth * 2);
  const childIndentation = ' '.repeat((depth + 1) * 2);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inline = `[${value.map(item => JSON.stringify(item)).join(', ')}]`;
    if (value.every(isPrimitive) && indentation.length + inline.length <= 100) return inline;
    const children = value.map(item => `${childIndentation}${serializeJson(item, depth + 1)}`);
    return `[\n${children.join(',\n')}\n${indentation}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  const children = entries.map(
    ([key, child]) =>
      `${childIndentation}${JSON.stringify(key)}: ${serializeJson(child, depth + 1)}`
  );
  return `{\n${children.join(',\n')}\n${indentation}}`;
};

const serialize = (value: JsonValue): string => `${serializeJson(value, 0)}\n`;

const copyNonFixtures = Effect.fn('copyNonFixtureFiles')(function* (
  source: string,
  prepared: string
) {
  const fileSystem = yield* FixtureFileSystem;
  const entries = yield* fileSystem.readDirectory(source);
  for (const entry of entries) {
    if (!isFixtureFilename(entry)) {
      yield* fileSystem.copy(join(source, entry), join(prepared, entry));
    }
  }
});

const writeCandidates = Effect.fn('writeFixtureCandidates')(function* (
  prepared: string,
  files: ReadonlyMap<FixtureFilename, JsonValue>
) {
  const fileSystem = yield* FixtureFileSystem;
  for (const filename of FIXTURE_FILENAMES) {
    const value = files.get(filename);
    if (value === undefined) {
      return yield* BatchValidationError.make({
        diagnostics: [
          {
            filename,
            path: '',
            expected: 'complete sanitized batch',
            observed: 'missing candidate',
            category: 'batch-contract',
          },
        ],
      });
    }
    yield* fileSystem.writeText(join(prepared, filename), serialize(value));
  }
});

interface PreparedDirectory {
  readonly destination: string;
  readonly prepared: string;
  readonly backup: string;
  readonly destinationExisted: boolean;
}

const prepareDirectory = Effect.fn('prepareFixtureDirectory')(function* (
  destination: string,
  files: ReadonlyMap<FixtureFilename, JsonValue>,
  preserveNonFixtures: boolean
) {
  const fileSystem = yield* FixtureFileSystem;
  const prepared = `${destination}.prepare-${process.pid}`;
  const backup = `${destination}.backup`;
  yield* fileSystem.remove(prepared);
  let destinationExists = yield* fileSystem.exists(destination);
  const backupExists = yield* fileSystem.exists(backup);
  if (backupExists && destinationExists) {
    yield* fileSystem.remove(backup);
  }
  if (backupExists && !destinationExists) {
    yield* fileSystem.rename(backup, destination);
    destinationExists = true;
  }
  yield* fileSystem.makeDirectory(prepared);
  const preparation = yield* Effect.either(
    Effect.gen(function* () {
      if (preserveNonFixtures && destinationExists) {
        yield* copyNonFixtures(destination, prepared);
      }
      yield* writeCandidates(prepared, files);
    })
  );
  if (Either.isLeft(preparation)) {
    yield* Effect.ignore(fileSystem.remove(prepared));
    return yield* preparation.left;
  }
  return {
    destination,
    prepared,
    backup,
    destinationExisted: destinationExists,
  } satisfies PreparedDirectory;
});

const rollbackInstalledDirectory = Effect.fn('rollbackInstalledFixtureDirectory')(function* (
  installed: PreparedDirectory
) {
  const fileSystem = yield* FixtureFileSystem;
  yield* fileSystem.remove(installed.destination);
  if (installed.destinationExisted) {
    yield* fileSystem.rename(installed.backup, installed.destination);
  }
});

const installPreparedDirectory = Effect.fn('installPreparedFixtureDirectory')(function* (
  prepared: PreparedDirectory
) {
  const fileSystem = yield* FixtureFileSystem;
  if (prepared.destinationExisted) {
    yield* fileSystem.rename(prepared.destination, prepared.backup);
  }
  const installation = yield* Effect.either(
    fileSystem.rename(prepared.prepared, prepared.destination)
  );
  if (Either.isRight(installation)) return prepared;
  if (prepared.destinationExisted) {
    const rollback = yield* Effect.either(fileSystem.rename(prepared.backup, prepared.destination));
    if (Either.isLeft(rollback)) {
      return yield* TransactionError.make({
        operation: 'rollback',
        path: prepared.destination,
        category: rollback.left.category,
      });
    }
  }
  yield* fileSystem.remove(prepared.prepared);
  return yield* TransactionError.make({
    operation: 'install',
    path: prepared.destination,
    category: installation.left.category,
  });
});

const cleanupInstalledDirectory = Effect.fn('cleanupInstalledFixtureDirectory')(function* (
  installed: PreparedDirectory
) {
  if (!installed.destinationExisted) return;
  const fileSystem = yield* FixtureFileSystem;
  yield* fileSystem.remove(installed.backup);
});

const installOutputs = Effect.fn('installSanitizedFixtureOutputs')(function* (
  paths: WorkflowPaths,
  files: ReadonlyMap<FixtureFilename, JsonValue>,
  write: boolean
) {
  const fileSystem = yield* FixtureFileSystem;
  const staging = yield* prepareDirectory(paths.staging, files, false);
  if (!write) {
    const installed = yield* installPreparedDirectory(staging);
    yield* Effect.ignore(cleanupInstalledDirectory(installed));
    return;
  }

  const destinationPreparation = yield* Effect.either(
    prepareDirectory(paths.destination, files, true)
  );
  if (Either.isLeft(destinationPreparation)) {
    yield* Effect.ignore(fileSystem.remove(staging.prepared));
    return yield* destinationPreparation.left;
  }

  const stagingInstallation = yield* Effect.either(installPreparedDirectory(staging));
  if (Either.isLeft(stagingInstallation)) {
    yield* Effect.ignore(fileSystem.remove(destinationPreparation.right.prepared));
    return yield* stagingInstallation.left;
  }
  const installedStaging = stagingInstallation.right;
  const destinationInstallation = yield* Effect.either(
    installPreparedDirectory(destinationPreparation.right)
  );
  if (Either.isLeft(destinationInstallation)) {
    const stagingRollback = yield* Effect.either(rollbackInstalledDirectory(installedStaging));
    if (Either.isLeft(stagingRollback)) {
      return yield* TransactionError.make({
        operation: 'rollback-staging',
        path: paths.staging,
        category: stagingRollback.left.category,
      });
    }
    return yield* destinationInstallation.left;
  }
  yield* Effect.ignore(cleanupInstalledDirectory(installedStaging));
  yield* Effect.ignore(cleanupInstalledDirectory(destinationInstallation.right));
});

export const sanitizeFixtureWorkflow = Effect.fn('sanitizeFixtureWorkflow')(function* (
  options: WorkflowOptions
) {
  const fileSystem = yield* FixtureFileSystem;
  const entries = yield* fileSystem.readDirectory(options.paths.raw);
  const contractDiagnostics = batchContractDiagnostics(entries);
  if (contractDiagnostics.length > 0) {
    return yield* BatchValidationError.make({ diagnostics: contractDiagnostics });
  }

  const parsedFiles = new Map<FixtureFilename, JsonValue>();
  const loadDiagnostics: Array<SafeDiagnostic> = [];
  for (const filename of FIXTURE_FILENAMES) {
    const loaded = yield* Effect.either(
      fileSystem
        .readText(join(options.paths.raw, filename))
        .pipe(Effect.flatMap(text => parseFixture(filename, text)))
    );
    if (Either.isRight(loaded)) parsedFiles.set(filename, loaded.right);
    else if (loaded.left._tag === 'BatchValidationError') {
      loadDiagnostics.push(...loaded.left.diagnostics);
    } else {
      loadDiagnostics.push({
        filename,
        path: '',
        expected: 'readable fixture file',
        observed: loaded.left.category,
        category: 'filesystem',
      });
    }
  }
  const sanitized = sanitizeBatch(parsedFiles);
  if (!sanitized.ok) {
    return yield* BatchValidationError.make({
      diagnostics: [...loadDiagnostics, ...sanitizerDiagnostics(sanitized.violations)],
    });
  }
  if (loadDiagnostics.length > 0) {
    return yield* BatchValidationError.make({
      diagnostics: loadDiagnostics,
    });
  }

  const endpointResults = yield* Effect.all(
    FIXTURE_FILENAMES.map(filename => {
      const candidate = sanitized.files.get(filename);
      return candidate === undefined
        ? Effect.fail(EndpointSchemaError.make({ filename }))
        : validateEndpoint(filename, candidate);
    }),
    { mode: 'either' }
  );
  const endpointDiagnostics: Array<SafeDiagnostic> = [];
  for (const result of endpointResults) {
    if (Either.isLeft(result)) {
      endpointDiagnostics.push({
        filename: result.left.filename,
        path: '',
        expected: 'endpoint Effect Schema decode',
        observed: 'schema failure',
        category: 'endpoint-schema',
      });
    }
  }
  if (endpointDiagnostics.length > 0) {
    return yield* BatchValidationError.make({ diagnostics: endpointDiagnostics });
  }

  yield* installOutputs(options.paths, sanitized.files, options.write);
  return {
    fileCount: FIXTURE_FILENAMES.length,
    installed: options.write,
    stagingPath: options.paths.staging,
  } satisfies WorkflowResult;
});
