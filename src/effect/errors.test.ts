import { describe, expect, it } from 'vitest';
import {
  BrowserDownloadFailed,
  formatError,
  GraphQLRequestFailed,
  HttpError,
  InvalidInstagramUrl,
  MediaNotFound,
  NetworkError,
  ResponseShapeUnknown,
} from './errors.ts';

describe('formatError', () => {
  it('HttpError → "HTTP <status>" (legacy-compatible)', () => {
    expect(formatError(new HttpError({ status: 403, message: 'Forbidden' }))).toBe('HTTP 403');
    expect(formatError(new HttpError({ status: 429, message: 'Too Many Requests' }))).toBe(
      'HTTP 429'
    );
  });

  it('NetworkError → String(cause) (legacy-compatible)', () => {
    expect(formatError(new NetworkError({ cause: new Error('boom') }))).toBe('Error: boom');
    expect(formatError(new NetworkError({ cause: 'timed out' }))).toBe('timed out');
  });

  it('GraphQLRequestFailed → "GraphQL failed: <status>" (legacy-compatible)', () => {
    expect(formatError(new GraphQLRequestFailed({ status: 500 }))).toBe('GraphQL failed: 500');
  });

  it('InvalidInstagramUrl', () => {
    expect(formatError(new InvalidInstagramUrl({ url: 'https://example.com' }))).toBe(
      'Invalid Instagram URL: https://example.com'
    );
  });

  it('MediaNotFound', () => {
    expect(formatError(new MediaNotFound({ hint: 'post abc' }))).toBe('No media found: post abc');
  });

  it('ResponseShapeUnknown', () => {
    expect(formatError(new ResponseShapeUnknown({ context: 'shortcode query' }))).toBe(
      'Unexpected response shape: shortcode query'
    );
  });

  it('BrowserDownloadFailed', () => {
    expect(
      formatError(
        new BrowserDownloadFailed({ url: 'https://cdn.example.com/a.jpg', cause: 'disk full' })
      )
    ).toBe('Download failed for https://cdn.example.com/a.jpg: disk full');
  });

  it('non-tagged value falls back to String(err)', () => {
    expect(formatError('plain string')).toBe('plain string');
    expect(formatError(42)).toBe('42');
    expect(formatError(new Error('raw error'))).toBe('Error: raw error');
  });
});
