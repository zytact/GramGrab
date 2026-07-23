#!/usr/bin/env node
import 'tsx/esm';

const { runCli } = await import('../src/index.ts');

runCli(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
