import { WHATSAPP_MAX_CHUNK_BYTES } from './limits.ts';

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const BINARY_CHUNK_SIZE = 8_192;

export function encodeCanonicalBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK_SIZE) {
    const end = Math.min(offset + BINARY_CHUNK_SIZE, bytes.length);
    binary += String.fromCharCode(...bytes.subarray(offset, end));
  }
  return btoa(binary);
}

export function decodeCanonicalBase64(
  value: string,
  maximumDecodedLength = WHATSAPP_MAX_CHUNK_BYTES
): Uint8Array | undefined {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(value) ||
    value.length > Math.ceil(maximumDecodedLength / 3) * 4
  )
    return undefined;

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return undefined;
  }
  if (binary.length === 0 || binary.length > maximumDecodedLength) return undefined;

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return encodeCanonicalBase64(bytes) === value ? bytes : undefined;
}

export function splitIntoCanonicalBase64Chunks(
  bytes: Uint8Array,
  maximumChunkLength = WHATSAPP_MAX_CHUNK_BYTES
): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += maximumChunkLength) {
    chunks.push(
      encodeCanonicalBase64(
        bytes.subarray(offset, Math.min(offset + maximumChunkLength, bytes.length))
      )
    );
  }
  return chunks;
}
