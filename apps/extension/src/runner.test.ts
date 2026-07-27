import { describe, expect, it } from 'vite-plus/test';
import { Schema } from 'effect';
import {
  DirectExport,
  ExportOperation,
  HumanItemNumber,
  InternalItemIndex,
  MediaIdentity,
  OperationId,
} from '@gramgrab/protocol';
import { resolveRequestedRunnerMedia } from './runner.ts';

describe('runner media reconciliation', () => {
  it('resolves a reordered Instant by stable media ID', () => {
    const operation = ExportOperation.make({
      operationId: Schema.decodeUnknownSync(OperationId)('00000000-0000-4000-8000-000000000001'),
      itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(1),
      mediaIdentity: MediaIdentity.make({
        itemIndex: Schema.decodeUnknownSync(InternalItemIndex)(0),
        mediaId: 'target',
      }),
      mode: DirectExport.make({}),
    });
    const media = [
      {
        url: 'https://cdn.instagram.com/wrong.jpg',
        itemIndex: 0,
        mediaId: 'other',
        type: 'image' as const,
        filenameHint: 'other',
      },
      {
        url: 'https://cdn.instagram.com/fresh.jpg',
        itemIndex: 1,
        mediaId: 'target',
        type: 'image' as const,
        filenameHint: 'target',
      },
    ];

    expect(resolveRequestedRunnerMedia(media, operation)).toBe(media[1]);
  });
});
