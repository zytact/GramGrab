import { sendMessage } from '../messaging/send';
import { presentationForFailure } from '../errors/presentation';
import { maximumFrameSecond } from '../frame-export/timestamp';

const VIDEO_METADATA_UNAVAILABLE = 'Could not load video metadata. Retry.';

/**
 * Fetches one video through the background worker and measures it. A failure the worker classified
 * is reported in its own words; anything the popup itself could not do stays generic.
 */
export async function loadVideoMetadata(
  url: string
): Promise<{ dataUrl: string; durationSeconds: number } | { error: string }> {
  try {
    const response = await sendMessage({ type: 'FETCH_VIDEO_BLOB', url });
    if (!response.dataUrl)
      return {
        error: response.failure
          ? `${presentationForFailure(response.failure).title}. ${presentationForFailure(response.failure).explanation}`
          : VIDEO_METADATA_UNAVAILABLE,
      };
    return {
      dataUrl: response.dataUrl,
      durationSeconds: await getVideoDuration(response.dataUrl),
    };
  } catch {
    return { error: VIDEO_METADATA_UNAVAILABLE };
  }
}

function createExportVideo(dataUrl: string) {
  const exportVideo = document.createElement('video');
  exportVideo.src = dataUrl;
  exportVideo.muted = true;
  exportVideo.playsInline = true;
  exportVideo.crossOrigin = 'anonymous';
  return exportVideo;
}

function releaseVideo(video: HTMLVideoElement) {
  video.removeAttribute('src');
  video.load();
}

function getVideoDuration(dataUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = createExportVideo(dataUrl);
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('error', onError);
      window.clearTimeout(timeout);
      releaseVideo(video);
    };
    const onLoadedMetadata = () => {
      const duration = video.duration;
      cleanup();
      if (maximumFrameSecond(duration) === undefined) reject(new Error('duration unavailable'));
      else resolve(duration);
    };
    const onError = () => {
      cleanup();
      reject(new Error('video metadata unavailable'));
    };
    const timeout = window.setTimeout(onError, 5_000);
    video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}
