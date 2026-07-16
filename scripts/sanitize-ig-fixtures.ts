import { resolve } from 'node:path';
import { Effect } from 'effect';
import {
  FixtureFileSystemLive,
  sanitizeFixtureWorkflow,
  type WorkflowError,
} from './ig-fixture-sanitizer/workflow.ts';

const rawArguments = process.argv.slice(2);
const argumentsList = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments;
const validArguments =
  argumentsList.length === 0 || (argumentsList.length === 1 && argumentsList[0] === '--write');

if (!validArguments) {
  process.stderr.write('Usage: vp run sanitize:ig-fixtures [-- --write]\n');
  process.exitCode = 1;
} else {
  const repositoryRoot = resolve(import.meta.dirname, '..');
  const program = sanitizeFixtureWorkflow({
    paths: {
      raw: resolve(repositoryRoot, '.local/raw-fixtures'),
      staging: resolve(repositoryRoot, '.local/sanitized-fixtures'),
      destination: resolve(repositoryRoot, 'src/effect/__fixtures__'),
    },
    write: argumentsList[0] === '--write',
  }).pipe(Effect.provide(FixtureFileSystemLive));

  const renderFailure = (error: WorkflowError): void => {
    if (error._tag === 'BatchValidationError') {
      process.stderr.write(`Sanitization failed with ${error.diagnostics.length} violation(s):\n`);
      for (const diagnostic of error.diagnostics) {
        process.stderr.write(
          `${diagnostic.filename}\t${diagnostic.path}\t${diagnostic.expected}\t${diagnostic.observed}\t${diagnostic.category}\n`
        );
      }
    } else {
      process.stderr.write(`${error.path}\t${error.operation}\t${error.category}\n`);
    }
    process.exitCode = 1;
  };

  await Effect.runPromise(
    program.pipe(
      Effect.match({
        onFailure: renderFailure,
        onSuccess: result => {
          const destination = result.installed ? 'staging and committed fixtures' : 'staging';
          process.stdout.write(`Sanitized ${result.fileCount} fixtures into ${destination}.\n`);
          process.stdout.write(
            'Raw captures remain sensitive and must be removed manually when safe.\n'
          );
        },
      })
    )
  ).catch(() => {
    process.stderr.write('Sanitization terminated because of an unexpected defect.\n');
    process.exitCode = 1;
  });
}
