import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  DirectExport,
  ExportOperation,
  HumanItemNumber,
  OperationId,
  SilentExport,
} from '@gramgrab/protocol';
import { createRequestId } from '../download/contracts.ts';
import type { ReencodeCandidate } from './batch.ts';
import { SilentPreflight } from './contracts.ts';
import { approvedReencodeOperationIds } from './policy.ts';

function operationId(suffix: number) {
  return Schema.decodeUnknownSync(OperationId)(
    `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
  );
}

function requested(suffix: number, reencode: 'forbid' | 'allow' | 'require') {
  return ExportOperation.make({
    operationId: operationId(suffix),
    itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(suffix),
    mode: SilentExport.make({ reencode }),
  });
}

function candidate(request: ExportOperation): ReencodeCandidate {
  const requestId = createRequestId();
  return {
    operation: {
      operationId: request.operationId,
      requestId,
      itemIndex: request.itemNumber - 1,
      url: 'https://example.com/video.mp4',
      filename: 'silent.mp4',
      mediaType: 'video',
      originalUrl: 'https://example.com/video.mp4',
      originalFilename: 'video.mp4',
      mode: 'silent',
      displayIndex: request.itemNumber - 1,
    },
    preflight: SilentPreflight.make({
      operationId: request.operationId,
      requestId,
      durationSeconds: 1,
      videoCodec: 'avc',
      audioTrackCount: 1,
      width: 1920,
      height: 1080,
      copyCompatible: false,
    }),
  };
}

describe('CLI silent policy', () => {
  it('approves allow and require independently without approving forbid', () => {
    const forbid = requested(1, 'forbid');
    const allow = requested(2, 'allow');
    const require = requested(3, 'require');
    const requests = new Map(
      [forbid, allow, require].map(request => [request.operationId, request])
    );

    expect([
      ...approvedReencodeOperationIds([candidate(forbid), candidate(allow)], requests),
    ]).toEqual([allow.operationId]);
    expect([
      ...approvedReencodeOperationIds([candidate(allow), candidate(require)], requests),
    ]).toEqual([allow.operationId, require.operationId]);
  });

  it('treats a requested direct crop as consent and a plain direct export as none', () => {
    const crop = ExportOperation.make({
      operationId: operationId(4),
      itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(4),
      mode: DirectExport.make(),
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    const plain = ExportOperation.make({
      operationId: operationId(5),
      itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(5),
      mode: DirectExport.make(),
      rotation: 90,
    });
    const requests = new Map([crop, plain].map(request => [request.operationId, request]));

    expect([
      ...approvedReencodeOperationIds([candidate(crop), candidate(plain)], requests),
    ]).toEqual([crop.operationId]);
  });
});
