import type { OperationFailure, OperationWarning } from './contracts.ts';

export interface DiagnosticsInput {
  readonly extensionVersion: string;
  readonly browser: Readonly<Record<string, unknown>>;
  readonly source?: Readonly<Record<string, unknown>>;
  readonly attempt: Readonly<Record<string, unknown>>;
  readonly batchFailure?: OperationFailure;
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly warnings: readonly OperationWarning[];
}

export function buildDiagnostics(input: DiagnosticsInput, capturedAt = new Date()): string {
  return JSON.stringify(
    {
      diagnosticsVersion: 1,
      capturedAt: capturedAt.toISOString(),
      extensionVersion: input.extensionVersion,
      browser: input.browser,
      ...(input.source ? { source: input.source } : {}),
      attempt: input.attempt,
      ...(input.batchFailure ? { batchFailure: input.batchFailure } : {}),
      items: input.items,
      warnings: input.warnings,
    },
    null,
    2
  );
}
