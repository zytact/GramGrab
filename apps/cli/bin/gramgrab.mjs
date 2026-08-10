#!/usr/bin/env node
import 'tsx/esm';

const { formatCliError, runCli } = await import('../src/index.ts');

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

runCli(process.argv.slice(2), controller.signal).catch(error => {
  process.stderr.write(formatCliError(error, process.argv.includes('--json')));
  process.exitCode = 2;
});
