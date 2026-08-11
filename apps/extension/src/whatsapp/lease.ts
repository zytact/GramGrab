import { WHATSAPP_MAX_MEDIA_BYTES } from './limits.ts';

export interface WhatsAppLeaseCheck {
  readonly now: number;
  readonly deadline: number;
  readonly estimatedDurationMs: number;
}

export interface WhatsAppPeakMemoryCheck {
  readonly inputBytes: number;
  readonly outputBytes: number;
}

export function fitsWithinWhatsAppLease({
  now,
  deadline,
  estimatedDurationMs,
}: WhatsAppLeaseCheck): boolean {
  return (
    Number.isFinite(now) &&
    Number.isFinite(deadline) &&
    Number.isFinite(estimatedDurationMs) &&
    estimatedDurationMs >= 0 &&
    now + estimatedDurationMs <= deadline
  );
}

export function fitsWithinWhatsAppPeakMemory({
  inputBytes,
  outputBytes,
}: WhatsAppPeakMemoryCheck): boolean {
  return (
    Number.isSafeInteger(inputBytes) &&
    Number.isSafeInteger(outputBytes) &&
    inputBytes >= 0 &&
    outputBytes >= 0 &&
    inputBytes + outputBytes <= WHATSAPP_MAX_MEDIA_BYTES
  );
}
