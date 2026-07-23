import { describe, it, expect } from 'vite-plus/test';
import { blobToDataUrl, jsonToDataUrl } from './data-url';

describe('blobToDataUrl', () => {
  it('converts a small text blob to a base64 data URL', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' });
    const result = await blobToDataUrl(blob);
    expect(result).toBe('data:text/plain;base64,aGVsbG8=');
  });

  it('includes the correct MIME type in the data URL', async () => {
    const blob = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    const result = await blobToDataUrl(blob);
    expect(result).toMatch(/^data:image\/svg\+xml;base64,/);
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
  it('produces a data URL starting with data:application/json;base64,', () => {
    const url = jsonToDataUrl({ foo: 'bar' });
    expect(url).toMatch(/^data:application\/json;base64,/);
  });

  it('round-trips a JSON value correctly', () => {
    const value = { a: 1, b: 'hello', c: [true, null] };
    const url = jsonToDataUrl(value);
    const base64 = url.split(',')[1] ?? '';
    const decoded = atob(base64);
    // Re-encode UTF-8 from latin1 passthrough
    const json = decodeURIComponent(
      decoded
        .split('')
        .map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
    expect(JSON.parse(json)).toEqual(value);
  });

  it('handles unicode characters in JSON values', () => {
    const value = { name: 'café ☕' };
    // Should not throw
    expect(() => jsonToDataUrl(value)).not.toThrow();
    const url = jsonToDataUrl(value);
    expect(url).toMatch(/^data:application\/json;base64,/);
  });

  it('handles null and primitive values', () => {
    expect(() => jsonToDataUrl(null)).not.toThrow();
    expect(() => jsonToDataUrl(42)).not.toThrow();
    expect(() => jsonToDataUrl('string')).not.toThrow();
  });
});
