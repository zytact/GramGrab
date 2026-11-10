import { WHATSAPP_MAX_CHUNK_BYTES } from './limits.ts';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
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

function hasZeroTrailingBits(value: string): boolean {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding === 0) return true;
  const last = BASE64_ALPHABET.indexOf(value.charAt(value.length - padding - 1));
  return (last & (padding === 2 ? 0b1111 : 0b11)) === 0;
}

export function decodeCanonicalBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(value) ||
    !hasZeroTrailingBits(value) ||
    value.length > Math.ceil(WHATSAPP_MAX_CHUNK_BYTES / 3) * 4
  )
    return undefined;

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return undefined;
  }
  if (binary.length === 0 || binary.length > WHATSAPP_MAX_CHUNK_BYTES) return undefined;

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
