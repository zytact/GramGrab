#!/usr/bin/env node
import 'tsx/esm';

const { startNativeHost } = await import('../src/index.ts');

startNativeHost().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
