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
      profileById: { candidates: [{ kind: 'doc_id', id: 'profile-id', requests: [request] }] },
      profilePosts: { candidates: [{ kind: 'doc_id', id: 'posts-id', requests: [request] }] },
      profilePostsPage: {
        candidates: [{ kind: 'doc_id', id: 'posts-page-id', requests: [request] }],
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

  it('accepts the mobile GraphQL endpoint and no other path on its host', () => {
    const config = (endpoint: string) => encodedConfig({ endpoint, transport: 'form' });
    expect(() => decodeProtocolConfig(config('https://i.instagram.com/graphql_www'))).not.toThrow();
    expect(Schema.is(ProtocolConfig)(config('https://i.instagram.com/api/v1/graphql'))).toBe(false);
    expect(Schema.is(ProtocolConfig)(config('https://i.instagram.com/graphql_www?x=1'))).toBe(
      false
    );
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
