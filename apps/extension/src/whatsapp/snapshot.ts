import type { WhatsAppCaptureDescriptor } from './contracts.ts';

export class WhatsAppCaptureSnapshot {
  readonly descriptor: WhatsAppCaptureDescriptor;
  #blob: Blob | undefined;
  #objectUrl: string | undefined;
  #released = false;

  constructor(descriptor: WhatsAppCaptureDescriptor, bytes: Uint8Array<ArrayBuffer>[]) {
    this.descriptor = descriptor;
    this.#blob = new Blob(bytes, { type: descriptor.mimeType });
  }

  get blob(): Blob {
    if (!this.#blob) throw new Error('The WhatsApp capture snapshot has been released.');
    return this.#blob;
  }

  objectUrl(): string {
    if (this.#released) throw new Error('The WhatsApp capture snapshot has been released.');
    if (!this.#objectUrl) this.#objectUrl = URL.createObjectURL(this.blob);
    return this.#objectUrl;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = undefined;
    this.#blob = undefined;
  }
}

export function makeWhatsAppCaptureSnapshot(
  descriptor: WhatsAppCaptureDescriptor,
  bytes: Uint8Array<ArrayBuffer>[]
): WhatsAppCaptureSnapshot {
  return new WhatsAppCaptureSnapshot(descriptor, bytes);
}
