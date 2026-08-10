import { Either } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  buildWhatsAppDiagnostics,
  decodeDiagnostics,
  makeWhatsAppDiagnostics,
} from './diagnostics.ts';
import { normalizeBrowserDownloadFailure, normalizeWhatsAppCaptureFailure } from './normalize.ts';
import { presentationForFailure, retryable, type FailurePresentation } from './presentation.ts';
import type {
  RecoveryAction,
  WhatsAppExclusiveFailureCode,
  WhatsAppFailurePhase,
} from './contracts.ts';
import type { WhatsAppCaptureFailureReason } from '../whatsapp/capture.ts';

const scenarios = [
  [
    'page-access-failed',
    'WHATSAPP_PAGE_ACCESS_FAILED',
    'whatsapp-page-access',
    'after-user-action',
    ['retry-operation', 'copy-diagnostics'],
  ],
  [
    'not-visible',
    'WHATSAPP_STATUS_NOT_VISIBLE',
    'whatsapp-extraction',
    'after-user-action',
    ['retry-operation'],
  ],
  [
    'unsupported',
    'WHATSAPP_STATUS_UNSUPPORTED',
    'whatsapp-extraction',
    'after-user-action',
    ['retry-operation'],
  ],
  [
    'not-ready',
    'WHATSAPP_STATUS_NOT_READY',
    'whatsapp-extraction',
    'after-user-action',
    ['retry-operation'],
  ],
  [
    'status-changed',
    'WHATSAPP_STATUS_CHANGED',
    'whatsapp-extraction',
    'after-user-action',
    ['retry-operation'],
  ],
  [
    'format-changed',
    'WHATSAPP_FORMAT_CHANGED',
    'whatsapp-extraction',
    'never',
    ['copy-diagnostics'],
  ],
  [
    'transfer-failed',
    'WHATSAPP_ACQUISITION_FAILED',
    'whatsapp-extraction',
    'once',
    ['retry-operation', 'copy-diagnostics'],
  ],
] as const satisfies readonly (readonly [
  WhatsAppCaptureFailureReason,
  WhatsAppExclusiveFailureCode,
  WhatsAppFailurePhase,
  FailurePresentation['retry'],
  readonly RecoveryAction[],
])[];

describe('WhatsApp failure registry', () => {
  it.each(scenarios)(
    '%s maps to the specified code, phase, retry policy, and actions',
    (reason, code, phase, retry, actions) => {
      const failure = normalizeWhatsAppCaptureFailure(reason);
      expect(failure).toMatchObject({ code, phase, scope: 'item', platform: 'whatsapp' });
      expect(presentationForFailure(failure)).toMatchObject({ retry, actions });
    }
  );

  it.each([
    ['permission denied', 'BROWSER_DOWNLOAD_BLOCKED', 'after-user-action', ['retry-operation']],
    ['network unavailable', 'BROWSER_DOWNLOAD_NETWORK_FAILED', 'once', ['retry-operation']],
    ['disk full', 'BROWSER_DOWNLOAD_FILE_FAILED', 'after-user-action', ['retry-operation']],
    [
      'unexpected browser failure',
      'DOWNLOAD_UNEXPECTED_FAILURE',
      'once',
      ['retry-operation', 'copy-diagnostics'],
    ],
  ] as const)(
    'normalizes %s into the WhatsApp %s branch with its shared presentation',
    (message, code, retry, actions) => {
      const failure = normalizeBrowserDownloadFailure(new Error(message), 'whatsapp');
      expect(failure).toMatchObject({ code, phase: 'browser-download', platform: 'whatsapp' });
      expect(presentationForFailure(failure)).toMatchObject({ actions, retry });
      expect(presentationForFailure(failure).actions).not.toContain('refetch-source');
    }
  );

  it('permits one manual acquisition retry and never permits a format retry', () => {
    const acquisition = normalizeWhatsAppCaptureFailure('transfer-failed');
    const format = normalizeWhatsAppCaptureFailure('format-changed');
    expect(retryable(acquisition, 0)).toBe(true);
    expect(retryable(acquisition, 1)).toBe(false);
    expect(retryable(format, 0)).toBe(false);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error('Expected a JSON object');
  return value;
}

describe('WhatsApp structural diagnostics', () => {
  const failure = normalizeWhatsAppCaptureFailure('format-changed', {
    playerCount: 1,
    imageCount: 2,
    blobImageCount: 1,
    dataImageCount: 1,
    videoCount: 0,
    markedVideoCount: 0,
    overflow: false,
  });
  const input = {
    extensionVersion: '1.2.3',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0.0.0',
    failure,
  };

  it('builds the closed WhatsApp discriminated branch', () => {
    const report = makeWhatsAppDiagnostics(input, new Date('2026-01-02T03:04:05.000Z'));
    expect(report).toMatchObject({
      diagnosticsVersion: 2,
      platform: 'whatsapp',
      capturedAt: 1_767_323_045_000,
      failure: { code: 'WHATSAPP_FORMAT_CHANGED', phase: 'whatsapp-extraction', scope: 'item' },
    });
    expect('cause' in report).toBe(false);
    expect('items' in report).toBe(false);
  });

  it('fails closed for every secret-carrying WhatsApp field', () => {
    const json = buildWhatsAppDiagnostics(input, new Date('2026-01-02T03:04:05.000Z'));
    const report = parseObject(json);
    const evidence = report.evidence;
    if (!isRecord(evidence)) throw new Error('Expected structural evidence');
    const secrets = {
      url: 'https://web.whatsapp.com/SECRET_URL',
      contactId: 'CONTACT_IDENTIFIER_SECRET',
      filename: 'FILENAME_SECRET.jpg',
      operationId: '00000000-0000-4000-8000-000000000001',
      requestId: '10000000-0000-4000-8000-000000000001',
      cause: 'FREE_FORM_CAUSE_SECRET',
    };
    for (const [field, secret] of Object.entries(secrets)) {
      expect(json).not.toContain(secret);
      expect(Either.isLeft(decodeDiagnostics({ ...report, [field]: secret }))).toBe(true);
      expect(
        Either.isLeft(decodeDiagnostics({ ...report, evidence: { ...evidence, [field]: secret } }))
      ).toBe(true);
    }
  });
});
