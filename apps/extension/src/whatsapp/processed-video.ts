import { BufferTarget } from 'mediabunny';
import type { AttemptOperation } from '../download/attempt.ts';
import {
  inspectSilentVideo,
  validateProcessedVideo,
  writeProcessedVideo,
} from '../silent-video/engine.ts';
import type { WhatsAppExportProgress } from './export.ts';

export async function processedVideo(
  source: Blob,
  operation: AttemptOperation,
  onProgress: WhatsAppExportProgress
): Promise<Blob> {
  onProgress('inspecting', 0);
  const preflight = await inspectSilentVideo(operation.operationId, operation.requestId, source);
  const keepAudio = operation.mode !== 'silent';
  const target = new BufferTarget();
  await writeProcessedVideo(
    source,
    target,
    preflight.durationSeconds,
    operation.crop !== undefined || !preflight.copyCompatible,
    {
      keepAudio,
      ...(operation.rotation ? { rotation: operation.rotation } : {}),
      ...(operation.crop ? { crop: operation.crop } : {}),
    },
    progress => onProgress('processing', progress)
  );
  if (!target.buffer) throw new Error('The processed video produced no output.');
  const output = new Blob([target.buffer], { type: 'video/mp4' });
  onProgress('validating', 1);
  await validateProcessedVideo(output, keepAudio);
  return output;
}
