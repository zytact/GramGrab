import { cp, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Either, Layer } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  FileSystemError,
  FixtureFileSystem,
  FixtureFileSystemLive,
  fixtureFileSystemLive,
  sanitizeFixtureWorkflow,
  type WorkflowPaths,
} from '../scripts/ig-fixture-sanitizer/workflow.ts';
import { FIXTURE_FILENAMES } from '../scripts/ig-fixture-sanitizer/policy.ts';

const committedFixtures = join(import.meta.dirname, 'effect', '__fixtures__');

const makeWorkspace = async (): Promise<{
  readonly root: string;
  readonly paths: WorkflowPaths;
}> => {
  const root = await mkdtemp(join(tmpdir(), 'gramgrab-sanitizer-'));
  const paths = {
    raw: join(root, 'raw'),
    staging: join(root, 'staging'),
    destination: join(root, 'destination'),
  };
  await mkdir(paths.raw, { recursive: true });
  return { root, paths };
};

const copyBatch = async (destination: string): Promise<void> => {
  await mkdir(destination, { recursive: true });
  for (const filename of FIXTURE_FILENAMES) {
    await cp(join(committedFixtures, filename), join(destination, filename));
  }
};

const run = (paths: WorkflowPaths, write: boolean, layer = FixtureFileSystemLive) =>
  Effect.runPromise(
    Effect.either(sanitizeFixtureWorkflow({ paths, write }).pipe(Effect.provide(layer)))
  );

describe('IG fixture sanitizer workflow', () => {
  it('requires exactly the complete eight-file input and performs no writes on failure', async () => {
    const { paths } = await makeWorkspace();
    await copyBatch(paths.raw);
    const missing = FIXTURE_FILENAMES[0];
    expect(missing).toBeDefined();
    if (!missing) return;
    const { rm } = await import('node:fs/promises');
    await rm(join(paths.raw, missing));
    await mkdir(paths.staging);
    await writeFile(join(paths.staging, 'safe-marker.txt'), 'unchanged-safe-marker');

    const result = await run(paths, false);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe('BatchValidationError');
    }
    expect(await readFile(join(paths.staging, 'safe-marker.txt'), 'utf8')).toBe(
      'unchanged-safe-marker'
    );
  });

  it('aggregates value-free JSON and policy diagnostics across files', async () => {
    const { paths } = await makeWorkspace();
    await copyBatch(paths.raw);
    await writeFile(join(paths.raw, 'avatar.json'), '{synthetic-invalid-json');
    await writeFile(
      join(paths.raw, 'highlights-tray.json'),
      JSON.stringify({ synthetic_unknown: 'synthetic-secret-that-must-not-appear' })
    );

    const result = await run(paths, false);
    expect(Either.isLeft(result)).toBe(true);
    if (!Either.isLeft(result) || result.left._tag !== 'BatchValidationError') return;
    expect(result.left.diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(result.left.diagnostics)).not.toContain(
      'synthetic-secret-that-must-not-appear'
    );
    await expect(readdir(paths.staging)).rejects.toBeDefined();
  });

  it('regenerates staging only after all candidates pass endpoint Schema decoding', async () => {
    const { paths } = await makeWorkspace();
    await copyBatch(paths.raw);
    const successful = await run(paths, false);
    expect(Either.isRight(successful)).toBe(true);
    expect((await readdir(paths.staging)).sort()).toEqual([...FIXTURE_FILENAMES].sort());

    await writeFile(join(paths.raw, 'avatar.json'), JSON.stringify({ status: 'ok' }));
    await writeFile(join(paths.raw, 'highlights-tray.json'), JSON.stringify({ status: 'ok' }));
    const before = await readFile(join(paths.staging, 'avatar.json'), 'utf8');
    const failed = await run(paths, false);
    expect(Either.isLeft(failed)).toBe(true);
    if (Either.isLeft(failed)) {
      expect(failed.left._tag).toBe('BatchValidationError');
      if (failed.left._tag === 'BatchValidationError') {
        expect(failed.left.diagnostics).toHaveLength(2);
        expect(failed.left.diagnostics.every(item => item.category === 'endpoint-schema')).toBe(
          true
        );
      }
    }
    expect(await readFile(join(paths.staging, 'avatar.json'), 'utf8')).toBe(before);
  });

  it('installs all fixtures transactionally while preserving non-fixture files', async () => {
    const { paths } = await makeWorkspace();
    await copyBatch(paths.raw);
    await copyBatch(paths.destination);
    await writeFile(join(paths.destination, 'README.md'), 'safe documentation marker');
    await writeFile(join(paths.destination, 'operator-note.txt'), 'safe operator marker');

    const result = await run(paths, true);
    expect(Either.isRight(result)).toBe(true);
    expect(await readFile(join(paths.destination, 'README.md'), 'utf8')).toBe(
      'safe documentation marker'
    );
    expect(await readFile(join(paths.destination, 'operator-note.txt'), 'utf8')).toBe(
      'safe operator marker'
    );
    const installedJson = (await readdir(paths.destination)).filter(name => name.endsWith('.json'));
    expect(installedJson.sort()).toEqual([...FIXTURE_FILENAMES].sort());
  });

  it('rolls the destination directory back when the final install rename fails', async () => {
    const { paths } = await makeWorkspace();
    await copyBatch(paths.raw);
    await copyBatch(paths.staging);
    await writeFile(join(paths.staging, 'staging-note.txt'), 'safe old staging marker');
    await copyBatch(paths.destination);
    await writeFile(join(paths.destination, 'operator-note.txt'), 'safe rollback marker');
    const originalAvatar = await readFile(join(paths.destination, 'avatar.json'), 'utf8');
    let renameCount = 0;
    const failingLayer = Layer.succeed(FixtureFileSystem)({
      ...fixtureFileSystemLive,
      rename: (source, destination) => {
        renameCount += 1;
        return renameCount === 4
          ? Effect.fail(
              FileSystemError.make({
                operation: 'rename',
                path: destination,
                category: 'SyntheticRenameFailure',
              })
            )
          : fixtureFileSystemLive.rename(source, destination);
      },
    });

    const result = await run(paths, true, failingLayer);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left._tag).toBe('TransactionError');
    expect(await readFile(join(paths.destination, 'operator-note.txt'), 'utf8')).toBe(
      'safe rollback marker'
    );
    expect(await readFile(join(paths.destination, 'avatar.json'), 'utf8')).toBe(originalAvatar);
    expect(await readFile(join(paths.staging, 'staging-note.txt'), 'utf8')).toBe(
      'safe old staging marker'
    );
  });

  it('recovers a retained backup on the invocation after rollback itself fails', async () => {
    const { root, paths } = await makeWorkspace();
    await copyBatch(paths.raw);
    await copyBatch(paths.destination);
    await writeFile(join(paths.destination, 'operator-note.txt'), 'safe recovery marker');
    let renameCount = 0;
    const failingLayer = Layer.succeed(FixtureFileSystem)({
      ...fixtureFileSystemLive,
      rename: (source, destination) => {
        renameCount += 1;
        return renameCount === 3 || renameCount === 4
          ? Effect.fail(
              FileSystemError.make({
                operation: 'rename',
                path: destination,
                category: 'SyntheticRollbackFailure',
              })
            )
          : fixtureFileSystemLive.rename(source, destination);
      },
    });

    const failed = await run(paths, true, failingLayer);
    expect(Either.isLeft(failed)).toBe(true);
    expect((await readdir(root)).some(name => name === 'destination.backup')).toBe(true);
    const recovered = await run(paths, true);
    expect(Either.isRight(recovered)).toBe(true);
    expect(await readFile(join(paths.destination, 'operator-note.txt'), 'utf8')).toBe(
      'safe recovery marker'
    );
  });

  it('does not replace staging when destination preparation fails', async () => {
    const { paths } = await makeWorkspace();
    await copyBatch(paths.raw);
    await copyBatch(paths.staging);
    await writeFile(join(paths.staging, 'staging-note.txt'), 'safe preparation marker');
    await copyBatch(paths.destination);
    const failingLayer = Layer.succeed(FixtureFileSystem)({
      ...fixtureFileSystemLive,
      writeText: (path, contents) =>
        path.includes('destination.prepare-')
          ? Effect.fail(
              FileSystemError.make({
                operation: 'write',
                path,
                category: 'SyntheticWriteFailure',
              })
            )
          : fixtureFileSystemLive.writeText(path, contents),
    });

    const result = await run(paths, true, failingLayer);
    expect(Either.isLeft(result)).toBe(true);
    expect(await readFile(join(paths.staging, 'staging-note.txt'), 'utf8')).toBe(
      'safe preparation marker'
    );
  });

  it('removes destination preparation when staging installation fails', async () => {
    const { root, paths } = await makeWorkspace();
    await copyBatch(paths.raw);
    await copyBatch(paths.destination);
    const failingLayer = Layer.succeed(FixtureFileSystem)({
      ...fixtureFileSystemLive,
      rename: (source, destination) =>
        destination === paths.staging
          ? Effect.fail(
              FileSystemError.make({
                operation: 'rename',
                path: destination,
                category: 'SyntheticStagingFailure',
              })
            )
          : fixtureFileSystemLive.rename(source, destination),
    });

    const result = await run(paths, true, failingLayer);
    expect(Either.isLeft(result)).toBe(true);
    expect((await readdir(root)).some(name => name.includes('destination.prepare-'))).toBe(false);
  });

  it('keeps successful outputs usable when backup cleanup fails', async () => {
    const { root, paths } = await makeWorkspace();
    await copyBatch(paths.raw);
    await copyBatch(paths.staging);
    await copyBatch(paths.destination);
    const failingCleanupLayer = Layer.succeed(FixtureFileSystem)({
      ...fixtureFileSystemLive,
      remove: path =>
        path.endsWith('.backup')
          ? Effect.fail(
              FileSystemError.make({
                operation: 'remove',
                path,
                category: 'SyntheticCleanupFailure',
              })
            )
          : fixtureFileSystemLive.remove(path),
    });

    const installed = await run(paths, true, failingCleanupLayer);
    expect(Either.isRight(installed)).toBe(true);
    const nextRun = await run(paths, true);
    expect(Either.isRight(nextRun)).toBe(true);
    expect((await readdir(root)).some(name => name.endsWith('.backup'))).toBe(false);
  });
});
