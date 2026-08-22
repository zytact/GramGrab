import { describe, expect, it } from 'vite-plus/test';
import { decodeMessage } from './contracts.ts';

describe('decodeMessage', () => {
  it('decodes a known message and keeps its discriminant', () => {
    const decoded = decodeMessage({ type: 'FETCH_MEDIA', url: 'https://www.instagram.com/p/a/' });

    expect(decoded).toEqual({
      kind: 'message',
      message: { type: 'FETCH_MEDIA', url: 'https://www.instagram.com/p/a/' },
    });
  });

  it('accepts a field a newer sender added, and drops it', () => {
    const decoded = decodeMessage({
      type: 'GET_PREVIEW_URL',
      url: 'https://cdn.instagram.com/a.jpg',
      preferredWidth: 1080,
    });

    expect(decoded).toEqual({
      kind: 'message',
      message: { type: 'GET_PREVIEW_URL', url: 'https://cdn.instagram.com/a.jpg' },
    });
  });

  it('reports a known type it cannot read as unsupported rather than guessing', () => {
    expect(decodeMessage({ type: 'DELETE_HISTORY_ENTRY' })).toEqual({
      kind: 'unsupported',
      type: 'DELETE_HISTORY_ENTRY',
    });
  });

  it.each([
    ['an unknown type', { type: 'FETCH_TELEPATHICALLY' }],
    ['a message with no type', { url: 'https://www.instagram.com/p/a/' }],
    ['a non-object', 'FETCH_MEDIA'],
  ])('treats %s as foreign', (_label, value) => {
    expect(decodeMessage(value)).toEqual({ kind: 'foreign' });
  });
});
