import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { FailureCodeSchema as ProtocolFailureCode } from '@gramgrab/protocol';
import { OperationFailure, watchFailure } from './contracts.ts';
import { FAILURE_PRESENTATION } from './presentation.ts';
import { buildWatchDiagnostics, decodeDiagnostics } from './diagnostics.ts';

const shapes = [
  ['WATCH_STORY_EXPIRED', 'resolving', 'item'],
  ['WATCH_AVATAR_CHANGED', 'resolving', 'item'],
  ['WATCH_INSTANT_NOT_IN_FEED', 'resolving', 'item'],
  ['WATCH_MEDIA_UNAVAILABLE', 'resolving', 'item'],
  ['WATCH_USERNAME_UNCONFIRMED', 'resolving', 'batch'],
  ['WATCH_CHECK_INCOMPLETE', 'resolving', 'batch'],
  ['WATCH_STORE_CAPACITY_EXCEEDED', 'watch', 'batch'],
  ['WATCH_STORE_FAILED', 'watch', 'batch'],
  ['WATCH_STORE_VERSION_UNSUPPORTED', 'watch', 'batch'],
  ['WATCH_STORE_UNREADABLE', 'watch', 'batch'],
  ['WATCH_NOT_FOUND', 'watch', 'batch'],
  ['WATCH_CONFIG_CONFLICT', 'watch', 'batch'],
  ['WATCH_UNATTENDED_NOT_ACCEPTED', 'watch', 'batch'],
  ['WATCH_RECOVERY_NOT_APPLICABLE', 'watch', 'item'],
  ['WATCH_NOTIFY_PERMISSION_DENIED', 'watch', 'item'],
  ['WATCH_NOTIFY_FAILED', 'watch', 'item'],
] as const;
const capturedAt = new Date('2026-10-05T00:00:00Z');
const input = {
  extensionVersion: '1.1.0',
  userAgent: 'Mozilla/5.0 Firefox/144.0 account-session-secret',
  failure: watchFailure('WATCH_STORE_FAILED'),
};

describe('Watch diagnostic privacy and failure contracts', () => {
  it.each(shapes)('round-trips %s with its canonical phase and scope', (code, phase, scope) => {
    const failure = watchFailure(code, 'posts');
    expect(failure).toMatchObject({ platform: 'watch', code, phase, scope, mediaKind: 'posts' });
    expect(Schema.decodeUnknownSync(ProtocolFailureCode)(code)).toBe(code);
    expect(
      Schema.decodeUnknownSync(OperationFailure, { onExcessProperty: 'error' })(failure)
    ).toEqual(failure);
    expect(FAILURE_PRESENTATION[code].explanation).not.toBe('');
    const report = JSON.parse(buildWatchDiagnostics({ ...input, failure }, capturedAt));
    expect(decodeDiagnostics(report)._tag).toBe('Right');
    expect(report.failure).toEqual({ code, phase, scope, mediaKind: 'posts' });
  });

  it('projects caller data onto structural fields and rejects contaminated reports', () => {
    const secret = 'account-media-session-secret';
    const enriched = {
      ...input,
      username: secret,
      viewerId: secret,
      mediaUrl: secret,
      cookie: secret,
      failure: Object.assign(watchFailure('WATCH_MEDIA_UNAVAILABLE', 'stories'), {
        cause: { message: secret },
        mediaId: secret,
        token: secret,
      }),
    };
    const report = JSON.parse(buildWatchDiagnostics(enriched, capturedAt));
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain('account-session-secret');
    expect(report.browser).toEqual({ family: 'firefox', majorVersion: 144, platform: 'unknown' });
    for (const value of [
      { ...report, viewerId: secret },
      { ...report, browser: { ...report.browser, userAgent: secret } },
      { ...report, failure: { ...report.failure, cause: { message: secret } } },
      { ...report, failure: { ...report.failure, mediaKind: secret } },
    ])
      expect(decodeDiagnostics(value)._tag).toBe('Left');
    expect(() =>
      Schema.decodeUnknownSync(OperationFailure, { onExcessProperty: 'error' })(
        Object.assign(watchFailure('WATCH_MEDIA_UNAVAILABLE'), { cause: { message: secret } })
      )
    ).toThrow();
  });

  it('rejects account and session data in version and kind fields at construction', () => {
    expect(() =>
      buildWatchDiagnostics({ ...input, extensionVersion: 'account/session-secret' })
    ).toThrow();
    expect(() =>
      buildWatchDiagnostics({
        ...input,
        failure: Object.assign(watchFailure('WATCH_STORE_FAILED'), { mediaKind: 'session-secret' }),
      })
    ).toThrow();
  });
});
