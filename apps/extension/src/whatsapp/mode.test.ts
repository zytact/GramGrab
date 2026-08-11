import { describe, expect, it } from 'vite-plus/test';
import { exportMode, silentFilename, whatsappExportSelection } from './mode.ts';

describe('WhatsApp export mode', () => {
  it('keeps frame and remove-audio as independent toggles with frame precedence', () => {
    expect(exportMode({ kind: 'video' }, false, false)).toBe('direct');
    expect(exportMode({ kind: 'video' }, true, false)).toBe('frame');
    expect(exportMode({ kind: 'video' }, false, true)).toBe('silent');
    expect(exportMode({ kind: 'video' }, true, true)).toBe('frame');
  });

  it('keeps photos plain-only', () => {
    expect(exportMode({ kind: 'photo' }, false, false)).toBe('direct');
    expect(exportMode({ kind: 'photo' }, true, true)).toBe('direct');
  });

  it('adds the muted suffix without exposing a source name', () => {
    expect(silentFilename('whatsapp-visible-status-20260811T000000Z.mp4')).toBe(
      'whatsapp-visible-status-20260811T000000Z-muted.mp4'
    );
  });

  it('derives mode and filename in one table-free decision', () => {
    expect(
      whatsappExportSelection(
        { kind: 'video' },
        true,
        true,
        'visible-status.mp4',
        'visible-status-frame.jpg'
      )
    ).toEqual({ mode: 'frame', filename: 'visible-status-frame.jpg' });
  });
});
