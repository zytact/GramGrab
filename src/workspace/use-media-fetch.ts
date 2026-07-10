import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { browser } from '../lib/browser';
import type { WorkspaceMediaItem } from './contracts';

type Status = 'idle' | 'fetching' | 'downloading' | 'done' | 'error';

interface MediaResponse {
  media?: {
    url: string;
    type: string;
    filenameHint: string;
    previewUrl?: string;
    width?: number;
    height?: number;
  }[];
  error?: string;
}

interface UseMediaFetchOptions {
  url: string;
  setFetchedUrl: Dispatch<SetStateAction<string>>;
  setMediaItems: Dispatch<SetStateAction<WorkspaceMediaItem[]>>;
  setExportFrameSet: Dispatch<SetStateAction<Set<number>>>;
  setStatus: Dispatch<SetStateAction<Status>>;
  setMessage: Dispatch<SetStateAction<string>>;
}

function applyFetchSuccess(
  media: NonNullable<MediaResponse['media']>,
  options: Omit<UseMediaFetchOptions, 'url' | 'setFetchedUrl'>
) {
  const items = media.map((item, index) => ({ ...item, index, selected: true }));
  options.setMediaItems(items);
  options.setExportFrameSet(new Set());
  options.setStatus(items.length > 0 ? 'done' : 'error');
  options.setMessage(
    items.length > 0
      ? `${items.length} item${items.length !== 1 ? 's' : ''} found — select and download.`
      : 'No downloadable media found.'
  );
}

export function useMediaFetch(options: UseMediaFetchOptions) {
  return useCallback(async () => {
    const trimmedUrl = options.url.trim();
    if (!trimmedUrl) {
      options.setMessage('No URL provided.');
      options.setStatus('error');
      return;
    }

    options.setStatus('fetching');
    options.setMessage('Fetching media…');
    try {
      const response = (await browser.runtime.sendMessage({
        type: 'FETCH_MEDIA',
        url: trimmedUrl,
      })) as MediaResponse;
      if (response?.error) {
        options.setMessage(response.error);
        options.setStatus('error');
        return;
      }
      options.setFetchedUrl(trimmedUrl);
      applyFetchSuccess(response?.media ?? [], options);
    } catch (err) {
      options.setMessage(String(err));
      options.setStatus('error');
    }
  }, [options]);
}
