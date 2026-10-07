import { Schema } from 'effect';
import { AvatarJpeg } from './contracts.ts';

/** The square side pictures are cropped and scaled to: twice the largest size the page shows. */
const SIDE = 80;
const base64 = (bytes: Uint8Array) => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

/** Loads a picture from the CDN and center-crops it to a small JPEG, or undefined if that fails. */
export async function loadJpeg(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return undefined;
    const bitmap = await createImageBitmap(await response.blob());
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(SIDE, SIDE);
    canvas
      .getContext('2d')
      ?.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        SIDE,
        SIDE
      );
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const jpeg = base64(new Uint8Array(await blob.arrayBuffer()));
    return Schema.is(AvatarJpeg)(jpeg) ? jpeg : undefined;
  } catch {
    return undefined;
  }
}

export const dataUrl = (jpeg: string) => `data:image/jpeg;base64,${jpeg}`;
