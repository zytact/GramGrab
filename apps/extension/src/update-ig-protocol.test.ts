import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  extractProtocolObservation,
  parseOperation,
  updateProtocolConfig,
} from '../scripts/update-ig-protocol.ts';

const postRequest = `fetch("https://www.instagram.com/api/graphql", {
  "headers": {
    "cookie": "sessionid=never-persist-this",
    "x-asbd-id": "new-asbd-id",
    "x-csrftoken": "never-persist-this-either",
    "x-ig-app-id": "new-app-id"
  },
  "body": "av=private-subject&doc_id=new-doc-id&fb_dtsg=secret&variables=%7B%22shortcode%22%3A%22private%22%7D",
  "method": "POST",
  "credentials": "include"
});`;

const getRequest = `fetch("https://www.instagram.com/graphql/query/?query_hash=new-query-hash&variables=%7B%22reel_ids%22%3A%5B%22private%22%5D%7D", {
  "headers": {
    "x-asbd-id": "new-asbd-id",
    "x-ig-app-id": "new-app-id"
  },
  "method": "GET"
});`;

const instantsRequest = `fetch("https://www.instagram.com/graphql/query", {
  "headers": {
    "x-csrftoken": "never-persist-this",
    "x-fb-friendly-name": "IGQuickSnapGetQuickSnapsQuery",
    "x-ig-app-id": "moonshot-app-id"
  },
  "body": "client_doc_id=new-client-doc-id&fb_api_req_friendly_name=IGQuickSnapGetQuickSnapsQuery&variables=%7B%7D",
  "method": "POST",
  "credentials": "include"
});`;

const initialConfig = {
  schemaVersion: 1,
  client: { appId: 'old-app-id', asbdId: 'old-asbd-id' },
  operations: {
    mediaByShortcode: {
      candidates: [
        {
          kind: 'doc_id',
          id: 'old-doc-id',
          requests: [{ endpoint: 'https://www.instagram.com/graphql/query/', transport: 'query' }],
        },
      ],
    },
    reelsMedia: {
      candidates: [
        {
          kind: 'query_hash',
          id: 'old-query-hash',
          requests: [{ endpoint: 'https://www.instagram.com/graphql/query/', transport: 'query' }],
        },
      ],
    },
  },
};

async function temporaryConfig() {
  const directory = await mkdtemp(join(tmpdir(), 'gramgrab-protocol-'));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`);
  return configPath;
}

describe('Copy-as-fetch protocol updater', () => {
  it('accepts Vite+ arguments with or without a separator', () => {
    expect(parseOperation(['--operation', 'mediaByShortcode'])).toBe('mediaByShortcode');
    expect(parseOperation(['--', '--operation', 'reelsMedia'])).toBe('reelsMedia');
    expect(parseOperation(['--operation', 'instantsFeed'])).toBe('instantsFeed');
  });

  it('extracts only public protocol metadata from a form POST', () => {
    const observation = extractProtocolObservation(postRequest);
    const serialized = JSON.stringify(observation);

    expect(observation).toEqual({
      appId: 'new-app-id',
      asbdId: 'new-asbd-id',
      candidate: {
        kind: 'doc_id',
        id: 'new-doc-id',
        requests: [{ endpoint: 'https://www.instagram.com/api/graphql', transport: 'form' }],
      },
    });
    expect(serialized).not.toContain('never-persist');
    expect(serialized).not.toContain('private-subject');
    expect(serialized).not.toContain('fb_dtsg');
    expect(serialized).not.toContain('variables');
  });

  it('extracts a query hash from a GET without retaining variable values', () => {
    const observation = extractProtocolObservation(getRequest);

    expect(observation.candidate).toEqual({
      kind: 'query_hash',
      id: 'new-query-hash',
      requests: [{ endpoint: 'https://www.instagram.com/graphql/query/', transport: 'query' }],
    });
    expect(JSON.stringify(observation)).not.toContain('reel_ids');
    expect(JSON.stringify(observation)).not.toContain('private');
  });

  it('updates the explicitly selected operation and preserves existing fallbacks', async () => {
    const configPath = await temporaryConfig();
    const updated = await updateProtocolConfig({
      source: postRequest,
      operation: 'mediaByShortcode',
      configPath,
    });

    expect(updated.client).toEqual({ appId: 'new-app-id', asbdId: 'new-asbd-id' });
    expect(updated.operations.mediaByShortcode.candidates.map(candidate => candidate.id)).toEqual([
      'new-doc-id',
      'old-doc-id',
    ]);
    expect(updated.operations.reelsMedia.candidates.map(candidate => candidate.id)).toEqual([
      'old-query-hash',
    ]);

    const saved = await readFile(configPath, 'utf8');
    expect(saved).toBe(`${JSON.stringify(updated, null, 2)}\n`);
    expect(saved).not.toContain('never-persist');
    expect(saved).not.toContain('private-subject');
  });

  it('stores Instant-specific public metadata without replacing the default web client', async () => {
    const configPath = await temporaryConfig();
    const updated = await updateProtocolConfig({
      source: instantsRequest,
      operation: 'instantsFeed',
      configPath,
    });

    expect(updated.client).toEqual(initialConfig.client);
    expect(updated.operations.instantsFeed).toMatchObject({
      appId: 'moonshot-app-id',
      friendlyName: 'IGQuickSnapGetQuickSnapsQuery',
      candidates: [{ kind: 'client_doc_id', id: 'new-client-doc-id' }],
    });
    expect(JSON.stringify(updated)).not.toContain('never-persist-this');
  });

  it('rejects unrelated or ambiguous input without modifying the configuration', async () => {
    const configPath = await temporaryConfig();
    const before = await readFile(configPath, 'utf8');
    const unrelatedRequest = postRequest.replace('doc_id=new-doc-id&', '');

    await expect(
      updateProtocolConfig({
        source: unrelatedRequest,
        operation: 'mediaByShortcode',
        configPath,
      })
    ).rejects.toThrow('exactly one doc_id, query_hash, or client_doc_id');
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('never evaluates the copied JavaScript', () => {
    globalThis.__gramgrabCopyAsFetchExecuted = false;
    const malicious = `${postRequest}\nglobalThis.__gramgrabCopyAsFetchExecuted = true;`;

    expect(() => extractProtocolObservation(malicious)).toThrow(
      'exactly one Copy-as-fetch request'
    );
    expect(globalThis.__gramgrabCopyAsFetchExecuted).toBe(false);
  });
});

declare global {
  var __gramgrabCopyAsFetchExecuted: boolean;
}
