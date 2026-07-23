import { describe, expect, it } from 'vite-plus/test';
import { buildDiagnostics } from './diagnostics.ts';

describe('attempt diagnostics', () => {
  it('builds versioned source-specific JSON without unrelated session data', () => {
    const json = buildDiagnostics(
      {
        extensionVersion: '1.2.3',
        browser: { name: 'Firefox' },
        source: { url: 'https://www.instagram.com/p/example/' },
        attempt: { operationId: 'operation', requestId: 'request' },
        items: [{ temporaryMediaUrl: 'https://cdn.instagram.com/signed' }],
        warnings: [],
      },
      new Date('2026-07-16T12:00:00.000Z')
    );
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.diagnosticsVersion).toBe(1);
    expect(json).toContain('temporaryMediaUrl');
    expect(json).not.toContain('cookie');
    expect(json).not.toContain('requestHeaders');
    expect(json).not.toContain('browserStorage');
  });
});
