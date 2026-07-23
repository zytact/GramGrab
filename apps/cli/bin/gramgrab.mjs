#!/usr/bin/env node
import 'tsx/esm';

const { runCli } = await import('../src/index.ts');

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

runCli(process.argv.slice(2), controller.signal).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
