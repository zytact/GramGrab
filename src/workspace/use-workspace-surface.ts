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
  WORKSPACE_TRANSFER_TTL_MS,
  type WorkspaceMediaItem,
  type WorkspaceSnapshot,
} from './contracts';

type SurfaceStatus = 'idle' | 'fetching' | 'downloading' | 'done' | 'error';

interface WorkspaceSurfaceOptions {
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
  exportFrameSet: Set<number>;
  setExportFrameSet: Dispatch<SetStateAction<Set<number>>>;
  setAutoDetected: Dispatch<SetStateAction<boolean>>;
}

function workspaceSnapshot({
  url,
  fetchedUrl,
  status,
  message,
  mediaItems,
  exportFrameSet,
}: Pick<
  WorkspaceSurfaceOptions,
  'url' | 'fetchedUrl' | 'status' | 'message' | 'mediaItems' | 'exportFrameSet'
>): WorkspaceSnapshot {
  const createdAt = Date.now();
  const resultsMatchDraftSource = fetchedUrl === url.trim();
  const settledStatus = status === 'error' ? 'error' : status === 'done' ? 'done' : 'idle';
  return {
    version: 1,
    createdAt,
    expiresAt: createdAt + WORKSPACE_TRANSFER_TTL_MS,
    url,
    fetchedUrl: resultsMatchDraftSource ? fetchedUrl : '',
    status: resultsMatchDraftSource ? settledStatus : 'idle',
    message: resultsMatchDraftSource ? message : 'Ready to fetch media.',
    mediaItems: resultsMatchDraftSource ? mediaItems : [],
    exportFrameIndexes: resultsMatchDraftSource ? [...exportFrameSet] : [],
  };
}

export function useWorkspaceSurface(options: WorkspaceSurfaceOptions) {
  const workspaceMode = new URLSearchParams(window.location.search).get('surface') === 'workspace';
  const [workspaceExists, setWorkspaceExists] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (workspaceMode) {
      void claimWorkspaceTransfer().then(snapshot => {
        const session = optionsRef.current;
        if (snapshot) {
          session.setUrl(snapshot.url);
          session.setFetchedUrl(snapshot.fetchedUrl);
          session.setStatus(snapshot.status);
          session.setMessage(snapshot.message);
          session.setMediaItems(snapshot.mediaItems);
          session.setExportFrameSet(new Set(snapshot.exportFrameIndexes));
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
  }, [workspaceMode]);

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
  const hasTransferableSession = isInstagramSource(options.url) || options.mediaItems.length > 0;

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
  };
}
