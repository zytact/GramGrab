import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { ProtocolConfig, decodeProtocolConfig, protocolConfig } from './config.ts';

describe('protocol configuration', () => {
  it('decodes the canonical configuration', () => {
    expect(protocolConfig.operations.mediaByShortcode.candidates).not.toHaveLength(0);
    expect(protocolConfig.operations.reelsMedia.candidates).not.toHaveLength(0);
  });

  const encodedConfig = (request: { readonly endpoint: string; readonly transport: string }) => ({
    schemaVersion: 1,
    client: { appId: 'app-id', asbdId: 'asbd-id' },
    operations: {
      mediaByShortcode: {
        candidates: [
          {
            kind: 'doc_id',
            id: 'shortcode-id',
            requests: [request],
          },
        ],
      },
      reelsMedia: {
        candidates: [
          {
            kind: 'doc_id',
            id: 'reels-id',
            requests: [request],
          },
        ],
      },
    },
  });

  it('preserves ordered candidates', () => {
    const decoded = decodeProtocolConfig({
      ...encodedConfig({
        endpoint: 'https://www.instagram.com/graphql/query',
        transport: 'query',
      }),
      operations: {
        ...encodedConfig({
          endpoint: 'https://www.instagram.com/graphql/query',
          transport: 'query',
        }).operations,
        mediaByShortcode: {
          candidates: ['first-id', 'second-id'].map(id => ({
            kind: 'doc_id',
            id,
            requests: [{ endpoint: 'https://www.instagram.com/graphql/query', transport: 'query' }],
          })),
        },
      },
    });

    expect(decoded.operations.mediaByShortcode.candidates.map(candidate => candidate.id)).toEqual([
      'first-id',
      'second-id',
    ]);
  });

  it('rejects unsafe endpoints and unsupported transports', () => {
    expect(
      Schema.is(ProtocolConfig)(
        encodedConfig({
          endpoint: 'https://instagram.com.example.test/graphql/query',
          transport: 'form',
        })
      )
    ).toBe(false);
    expect(
      Schema.is(ProtocolConfig)(
        encodedConfig({
          endpoint: 'https://www.instagram.com/graphql/query',
          transport: 'multipart',
        })
      )
    ).toBe(false);
  });
});
