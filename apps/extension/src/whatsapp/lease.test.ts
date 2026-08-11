import { describe, expect, it } from 'vite-plus/test';
import { fitsWithinWhatsAppLease, fitsWithinWhatsAppPeakMemory } from './lease.ts';
import { WHATSAPP_MAX_MEDIA_BYTES } from './limits.ts';

describe('WhatsApp edit lease guard', () => {
  it('accepts the exact remaining-time boundary and rejects an overrun', () => {
    expect(
      fitsWithinWhatsAppLease({ now: 9_000, deadline: 10_000, estimatedDurationMs: 1_000 })
    ).toBe(true);
    expect(
      fitsWithinWhatsAppLease({ now: 9_000, deadline: 10_000, estimatedDurationMs: 1_001 })
    ).toBe(false);
  });

  it('rejects expired and malformed lease budgets', () => {
    expect(fitsWithinWhatsAppLease({ now: 10_001, deadline: 10_000, estimatedDurationMs: 0 })).toBe(
      false
    );
    expect(fitsWithinWhatsAppLease({ now: 9_000, deadline: 10_000, estimatedDurationMs: -1 })).toBe(
      false
    );
    expect(
      fitsWithinWhatsAppLease({ now: Number.NaN, deadline: 10_000, estimatedDurationMs: 0 })
    ).toBe(false);
  });

  it('guards peak input plus output memory at the exact 64MB boundary', () => {
    expect(
      fitsWithinWhatsAppPeakMemory({
        inputBytes: 32 * 1024 * 1024,
        outputBytes: 32 * 1024 * 1024,
      })
    ).toBe(true);
    expect(
      fitsWithinWhatsAppPeakMemory({
        inputBytes: 32 * 1024 * 1024,
        outputBytes: 32 * 1024 * 1024 + 1,
      })
    ).toBe(false);
    expect(
      fitsWithinWhatsAppPeakMemory({
        inputBytes: WHATSAPP_MAX_MEDIA_BYTES - 1,
        outputBytes: 1,
      })
    ).toBe(true);
  });
});
