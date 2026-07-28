import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import { browser } from '../lib/browser';
import type { WorkspaceMediaItem } from './contracts';
import type { FrameExportSetting } from '../frame-export/timestamp';
import type { OperationFailure } from '../errors/contracts';
import { OperationFailure as OperationFailureModel } from '../errors/contracts';
import { FAILURE_PRESENTATION } from '../errors/presentation';

type Status = 'idle' | 'fetching' | 'downloading' | 'done' | 'error';

interface MediaResponse {
  media?: {
    url: string;
    itemIndex: number;
    mediaId?: string;
    history: { downloaded: boolean; count: number; latestDownloadedAt?: number };
    type: string;
    filenameHint: string;
    previewUrl?: string;
    width?: number;
    height?: number;
    creatorUsername?: string;
  }[];
  error?: string;
  failure?: OperationFailure;
}

interface UseMediaFetchOptions {
  url: string;
  acquisition: 'source' | 'instants';
  setFetchedUrl: Dispatch<SetStateAction<string>>;
  setMediaItems: Dispatch<SetStateAction<WorkspaceMediaItem[]>>;
  setFrameExportSettings: Dispatch<SetStateAction<Record<number, FrameExportSetting>>>;
  setStatus: Dispatch<SetStateAction<Status>>;
  setMessage: Dispatch<SetStateAction<string>>;
  onSuccess?: () => void;
  onFailure?: (failure: OperationFailure) => void;
}

function applyFetchSuccess(
  media: NonNullable<MediaResponse['media']>,
  options: Omit<UseMediaFetchOptions, 'url' | 'setFetchedUrl'>
) {
  const items = media.map((item, index) => ({ ...item, index, selected: true }));
  options.setMediaItems(items);
  options.setFrameExportSettings({});
  options.setStatus(items.length > 0 || options.acquisition === 'instants' ? 'done' : 'error');
  options.setMessage(
    items.length > 0
      ? `${items.length} item${items.length !== 1 ? 's' : ''} found — select and download.`
      : options.acquisition === 'instants'
        ? 'No active Instants.'
        : 'No downloadable media found.'
  );
}

export function useMediaFetch(options: UseMediaFetchOptions) {
  const requestGeneration = useRef(0);
  // fallow-ignore-next-line complexity
  return useCallback(async () => {
    const generation = ++requestGeneration.current;
    const trimmedUrl = options.url.trim();
    if (options.acquisition === 'source' && !trimmedUrl) {
      options.setMessage('No URL provided.');
      options.setStatus('error');
      return;
    }

    options.setStatus('fetching');
    options.setMessage('Fetching media…');
    try {
      const response = (await browser.runtime.sendMessage(
        options.acquisition === 'instants'
          ? { type: 'FETCH_INSTANTS' }
          : { type: 'FETCH_MEDIA', url: trimmedUrl }
      )) as MediaResponse;
      if (generation !== requestGeneration.current) return;
      if (response?.failure) {
        options.onFailure?.(response.failure);
        const presentation = FAILURE_PRESENTATION[response.failure.code];
        options.setMessage(`${presentation.title}. ${presentation.explanation}`);
        options.setStatus('error');
        return;
      }
      if (response?.error) {
        options.onFailure?.(
          OperationFailureModel.make({
            code: 'SOURCE_UNEXPECTED_FAILURE',
            phase: 'source',
            scope: 'batch',
          })
        );
        options.setMessage('GramGrab could not load this source.');
        options.setStatus('error');
        return;
      }
      options.setFetchedUrl(options.acquisition === 'source' ? trimmedUrl : '');
      applyFetchSuccess(response?.media ?? [], options);
      options.onSuccess?.();
    } catch {
      if (generation !== requestGeneration.current) return;
      options.setMessage('GramGrab could not contact the extension service.');
      options.onFailure?.(
        OperationFailureModel.make({
          code: 'SOURCE_UNEXPECTED_FAILURE',
          phase: 'source',
          scope: 'batch',
        })
      );
      options.setStatus('error');
    }
  }, [options]);
}
