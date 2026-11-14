import { sendMessage } from '../messaging/send';
import { presentationForFailure } from '../errors/presentation';
import { isOperationFailure, type OperationFailure } from '../errors/contracts';
import { maximumFrameSecond } from '../frame-export/timestamp';
import { fetchMedia } from '../download/fetch-media';

const VIDEO_METADATA_UNAVAILABLE = 'Could not load video metadata. Retry.';

function failureMessage(failure: OperationFailure) {
  const { title, explanation } = presentationForFailure(failure);
  return `${title}. ${explanation}`;
}

/**
 * Fetches one video through the background worker as a data URL, for a page that shows the video
 * from that URL, and measures it. A failure the worker classified is reported in its own words;
 * anything the page itself could not do stays generic.
 */
export async function loadVideoMetadata(
  url: string
): Promise<{ dataUrl: string; durationSeconds: number } | { error: string }> {
  try {
    const response = await sendMessage({ type: 'FETCH_VIDEO_BLOB', url });
    if (!response.dataUrl)
      return {
        error: response.failure ? failureMessage(response.failure) : VIDEO_METADATA_UNAVAILABLE,
      };
    return {
      dataUrl: response.dataUrl,
      durationSeconds: await measureDuration(response.dataUrl),
    };
  } catch {
    return { error: VIDEO_METADATA_UNAVAILABLE };
  }
}

/** Fetches one video and measures it straight from its bytes, keeping only the duration. */
export async function loadVideoDuration(
  url: string
): Promise<{ durationSeconds: number } | { error: string }> {
  try {
    const objectUrl = URL.createObjectURL(await fetchMedia(url));
    try {
      return { durationSeconds: await measureDuration(objectUrl) };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch (cause) {
    return {
      error: isOperationFailure(cause) ? failureMessage(cause) : VIDEO_METADATA_UNAVAILABLE,
    };
  }
}

function createExportVideo(src: string) {
  const exportVideo = document.createElement('video');
  exportVideo.src = src;
  exportVideo.muted = true;
  exportVideo.playsInline = true;
  exportVideo.crossOrigin = 'anonymous';
  return exportVideo;
}

function releaseVideo(video: HTMLVideoElement) {
  video.removeAttribute('src');
  video.load();
}

function measureDuration(src: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = createExportVideo(src);
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
