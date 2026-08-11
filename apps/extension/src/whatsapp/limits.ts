export const WHATSAPP_PROTOCOL_VERSION = 1 as const;
export const WHATSAPP_PORT_NAME = 'gramgrab-whatsapp-capture-v1' as const;
export const WHATSAPP_CONTROLLER_FILE = 'js/whatsapp-controller.js' as const;

export const WHATSAPP_MAX_MEDIA_BYTES = 64 * 1024 * 1024;
export const WHATSAPP_MAX_CHUNK_BYTES = 256 * 1024;
export const WHATSAPP_MAX_CHUNKS = 256;
export const WHATSAPP_MAX_UNACKNOWLEDGED_CHUNKS = 1;
export const WHATSAPP_IDLE_TIMEOUT_MS = 5_000;
export const WHATSAPP_TRANSFER_TIMEOUT_MS = 30_000;
export const WHATSAPP_RETENTION_MS = 60_000;
export const WHATSAPP_EDIT_LEASE_MS = 10 * 60_000;
export const WHATSAPP_MIN_DIMENSION = 1;
export const WHATSAPP_MAX_DIMENSION = 16_384;
export const WHATSAPP_MIN_VIDEO_DURATION_MS = 1;
export const WHATSAPP_MAX_VIDEO_DURATION_MS = 600_000;

const WHATSAPP_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const WHATSAPP_VIDEO_MIME_TYPES = ['video/mp4'] as const;
const WHATSAPP_MIME_TYPES = [...WHATSAPP_PHOTO_MIME_TYPES, ...WHATSAPP_VIDEO_MIME_TYPES] as const;

export type WhatsAppMimeType = (typeof WHATSAPP_MIME_TYPES)[number];

export function isWhatsAppWebUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'web.whatsapp.com' && url.port === '';
  } catch {
    return false;
  }
}

export function extensionForWhatsAppMime(
  mimeType: WhatsAppMimeType
): 'jpg' | 'png' | 'webp' | 'mp4' {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'video/mp4':
      return 'mp4';
  }
}
