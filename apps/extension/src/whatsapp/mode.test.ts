import { describe, expect, it } from 'vite-plus/test';
import { DIRECT_EXPORT, SILENT_EXPORT, silentFilename, whatsappExportSelection } from './mode.ts';

describe('WhatsApp export mode', () => {
  it('derives mode and filename from the one chosen export', () => {
    expect(
      whatsappExportSelection(
        { kind: 'video' },
        DIRECT_EXPORT,
        'visible-status.mp4',
        'visible-status-frame.jpg'
      )
    ).toEqual({ mode: 'direct', filename: 'visible-status.mp4' });
    expect(
      whatsappExportSelection(
        { kind: 'video' },
        { mode: 'frame', timestampSeconds: 9 },
        'visible-status.mp4',
        'visible-status-frame.jpg'
      )
    ).toEqual({
      mode: 'frame',
      filename: 'visible-status-frame.jpg',
      frameTimestampSeconds: 9,
    });
    expect(
      whatsappExportSelection(
        { kind: 'video' },
        SILENT_EXPORT,
        'visible-status.mp4',
        'visible-status-frame.jpg'
      )
    ).toEqual({ mode: 'silent', filename: 'visible-status-muted.mp4' });
  });

  it('keeps photos plain-only', () => {
    expect(
      whatsappExportSelection(
        { kind: 'photo' },
        { mode: 'frame', timestampSeconds: 3 },
        'visible-status.jpg',
        'visible-status-frame.jpg'
      )
    ).toEqual({ mode: 'direct', filename: 'visible-status.jpg' });
  });

  it('adds the muted suffix without exposing a source name', () => {
    expect(silentFilename('whatsapp-visible-status-20260811T000000Z.mp4')).toBe(
      'whatsapp-visible-status-20260811T000000Z-muted.mp4'
    );
  });
});
