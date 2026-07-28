import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { browser } from '../lib/browser';
import {
  claimWorkspaceTransfer,
  findWorkspaceTab,
  openWorkspace,
  replaceWorkspace,
} from './coordinator';
import {
  isBusy,
  isInstagramSource,
  WORKSPACE_STATUS_KEY,
  WORKSPACE_TRANSFER_TTL_MS,
  type WorkspaceMediaItem,
  type WorkspaceSnapshot,
} from './contracts';
import type { FrameExportSetting } from '../frame-export/timestamp';

type SurfaceStatus = 'idle' | 'fetching' | 'downloading' | 'done' | 'error';
type FetchTarget = 'source' | 'instants';

interface FetchIntent {
  id: number;
  target: FetchTarget;
}

interface WorkspaceSurfaceOptions {
  acquisition: 'source' | 'instants';
  setAcquisition: Dispatch<SetStateAction<'source' | 'instants'>>;
  url: string;
  setUrl: Dispatch<SetStateAction<string>>;
  fetchedUrl: string;
  setFetchedUrl: Dispatch<SetStateAction<string>>;
  status: SurfaceStatus;
  setStatus: Dispatch<SetStateAction<SurfaceStatus>>;
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
  mediaItems: WorkspaceMediaItem[];
  setMediaItems: Dispatch<SetStateAction<WorkspaceMediaItem[]>>;
  frameExportSettings: Record<number, FrameExportSetting>;
  setFrameExportSettings: Dispatch<SetStateAction<Record<number, FrameExportSetting>>>;
  removeAudioIndexes: Set<number>;
  setRemoveAudioIndexes: Dispatch<SetStateAction<Set<number>>>;
  setAutoDetected: Dispatch<SetStateAction<boolean>>;
}

function settledWorkspaceStatus(status: SurfaceStatus): WorkspaceSnapshot['status'] {
  if (status === 'error' || status === 'done') return status;
  return 'idle';
}

function workspaceSnapshot({
  url,
  fetchedUrl,
  status,
  message,
  mediaItems,
  frameExportSettings,
  removeAudioIndexes,
  acquisition,
}: Pick<
  WorkspaceSurfaceOptions,
  | 'url'
  | 'fetchedUrl'
  | 'status'
  | 'message'
  | 'mediaItems'
  | 'frameExportSettings'
  | 'removeAudioIndexes'
  | 'acquisition'
>): WorkspaceSnapshot {
  const createdAt = Date.now();
  const resultsMatchDraftSource = acquisition === 'instants' || fetchedUrl === url.trim();
  const snapshot = {
    version: 4,
    acquisition: { kind: acquisition },
    createdAt,
    expiresAt: createdAt + WORKSPACE_TRANSFER_TTL_MS,
    url,
  } as const;
  if (!resultsMatchDraftSource)
    return {
      ...snapshot,
      fetchedUrl: '',
      status: 'idle',
      message: 'Ready to fetch media.',
      mediaItems: [],
      frameExportSettings: {},
      removeAudioIndexes: [],
    };
  return {
    ...snapshot,
    fetchedUrl,
    status: settledWorkspaceStatus(status),
    message,
    mediaItems,
    frameExportSettings,
    removeAudioIndexes: [...removeAudioIndexes],
  };
}

export function useWorkspaceSurface(options: WorkspaceSurfaceOptions) {
  const workspaceMode = new URLSearchParams(window.location.search).get('surface') === 'workspace';
  const [workspaceExists, setWorkspaceExists] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [fetchIntent, setFetchIntent] = useState<FetchIntent>();
  const [downloadIntent, setDownloadIntent] = useState(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const requestFetch = useCallback((target: FetchTarget) => {
    setFetchIntent(current => ({ id: (current?.id ?? 0) + 1, target }));
  }, []);

  useEffect(() => {
    if (workspaceMode) {
      void claimWorkspaceTransfer().then(snapshot => {
        const session = optionsRef.current;
        if (snapshot) {
          session.setUrl(snapshot.url);
          session.setAcquisition(snapshot.acquisition.kind);
          session.setFetchedUrl(snapshot.fetchedUrl);
          session.setStatus(snapshot.status);
          session.setMessage(snapshot.message);
          session.setMediaItems(snapshot.mediaItems);
          session.setFrameExportSettings(snapshot.frameExportSettings);
          session.setRemoveAudioIndexes(new Set(snapshot.removeAudioIndexes));
          if (snapshot.autoStartDownload) setDownloadIntent(intent => intent + 1);
          if (snapshot.intent === 'fetch') requestFetch(snapshot.acquisition.kind);
          return;
        }
        const source = new URLSearchParams(window.location.search).get('source') ?? '';
        if (source) {
          session.setUrl(source);
          session.setMessage('Source restored - fetch media to refresh results.');
        }
      });
      return;
    }
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(tabs => {
        const currentUrl = tabs[0]?.url ?? '';
        if (currentUrl.includes('instagram.com')) {
          const session = optionsRef.current;
          session.setUrl(currentUrl);
          session.setAutoDetected(true);
          session.setMessage('Instagram URL detected — ready to fetch.');
        }
      })
      .catch(() => {});
  }, [requestFetch, workspaceMode]);

  useEffect(() => {
    if (!workspaceMode)
      void findWorkspaceTab()
        .then(tab => setWorkspaceExists(Boolean(tab)))
        .catch(() => {});
  }, [workspaceMode]);

  useEffect(() => {
    if (!workspaceMode) return;
    const page = new URL(window.location.href);
    if (options.url) page.searchParams.set('source', options.url);
    else page.searchParams.delete('source');
    window.history.replaceState({}, '', page);
  }, [options.url, workspaceMode]);

  const snapshot = useCallback(() => workspaceSnapshot(options), [options]);
  const busy = isBusy(options.status);
  const hasTransferableSession =
    options.acquisition === 'instants' ||
    isInstagramSource(options.url) ||
    options.mediaItems.length > 0;

  useEffect(() => {
    if (!workspaceMode) return;
    const publish = () =>
      browser.sessionStorage.set({ [WORKSPACE_STATUS_KEY]: { busy, updatedAt: Date.now() } });
    void publish();
    const interval = window.setInterval(() => void publish(), 3_000);
    return () => {
      window.clearInterval(interval);
      void browser.sessionStorage.remove(WORKSPACE_STATUS_KEY);
    };
  }, [busy, workspaceMode]);

  const handleOpenWorkspace = useCallback(async () => {
    if (busy) return;
    try {
      const result = await openWorkspace(snapshot());
      setWorkspaceExists(true);
      if (result === 'focused') options.setMessage('GramGrab workspace focused.');
    } catch (err) {
      options.setStatus('error');
      options.setMessage(`Could not open the workspace: ${String(err)}`);
    }
  }, [busy, options, snapshot]);

  const handleReplaceWorkspace = useCallback(async () => {
    try {
      await replaceWorkspace(snapshot());
      setConfirmReplace(false);
    } catch (err) {
      options.setStatus('error');
      options.setMessage(`Could not replace the workspace session: ${String(err)}`);
    }
  }, [options, snapshot]);

  return {
    workspaceMode,
    workspaceExists,
    confirmReplace,
    setConfirmReplace,
    handleOpenWorkspace,
    handleReplaceWorkspace,
    hasTransferableSession,
    fetchIntent,
    requestFetch,
    downloadIntent,
  };
}
