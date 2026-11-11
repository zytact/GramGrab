import { describe, it, expect } from 'vite-plus/test';
import { blobToDataUrl, jsonToDataUrl } from './data-url';

describe('blobToDataUrl', () => {
  it('converts a small text blob to a base64 data URL', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' });
    const result = await blobToDataUrl(blob);
    expect(result).toBe('data:text/plain;base64,aGVsbG8=');
  });

  it('falls back to application/octet-stream for blobs with no MIME type', async () => {
    const blob = new Blob(['raw']);
    const result = await blobToDataUrl(blob);
    expect(result).toMatch(/^data:application\/octet-stream;base64,/);
  });

  it('round-trips binary data correctly', async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const dataUrl = await blobToDataUrl(blob);
    // Decode and verify
    const base64 = dataUrl.split(',')[1] ?? '';
    const decoded = atob(base64);
    const result = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) result[i] = decoded.charCodeAt(i);
    expect(result).toEqual(bytes);
  });
});

describe('jsonToDataUrl', () => {
  it('round-trips a JSON value with unicode as a base64 JSON data URL', () => {
    const value = { a: 1, b: 'café ☕', c: [true, null] };
    const url = jsonToDataUrl(value);
    expect(url).toMatch(/^data:application\/json;base64,/);
    const bytes = Uint8Array.from(atob(url.split(',')[1] ?? ''), c => c.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(value);
  });
});
