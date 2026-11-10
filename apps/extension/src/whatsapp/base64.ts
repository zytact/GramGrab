import { WHATSAPP_MAX_CHUNK_BYTES } from './limits.ts';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function paddingLength(value: string): 0 | 1 | 2 {
  if (value.endsWith('==')) return 2;
  return value.endsWith('=') ? 1 : 0;
}

function hasZeroTrailingBits(value: string, padding: 0 | 1 | 2): boolean {
  if (padding === 0) return true;
  const lastSextet = BASE64_ALPHABET.indexOf(value.charAt(value.length - padding - 1));
  return (lastSextet & (padding === 2 ? 0b1111 : 0b11)) === 0;
}

export function isCanonicalBase64Chunk(value: string): boolean {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(WHATSAPP_MAX_CHUNK_BYTES / 3) * 4 ||
    !CANONICAL_BASE64.test(value)
  )
    return false;
  const padding = paddingLength(value);
  const decodedLength = (value.length / 4) * 3 - padding;
  return decodedLength <= WHATSAPP_MAX_CHUNK_BYTES && hasZeroTrailingBits(value, padding);
}

export function decodeCanonicalBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!isCanonicalBase64Chunk(value)) return undefined;

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
