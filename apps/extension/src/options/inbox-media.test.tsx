// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from 'vite-plus/test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { CommandFailure, DiscoverySummary, OperationFailure } from '@gramgrab/protocol';
import { resetBrowserMocks, setMockMessageHandler } from '../test/setup.ts';
import { loadVideoMetadata } from '../popup/video-metadata.ts';
import { useInboxMedia } from './inbox-media.tsx';

vi.mock('../popup/video-metadata.ts', () => ({ loadVideoMetadata: vi.fn() }));

const entryDetails = {
  watchId: 'watch',
  accountId: '1',
  username: 'instagram',
  instagramUrl: 'https://www.instagram.com/stories/instagram/1/',
  kind: 'stories' as const,
  mediaType: 'video' as const,
  discoveredAt: 1,
};
const entry = DiscoverySummary.make({
  ...entryDetails,
  entryId: '0b8e3d5c-2a4f-4e6b-9c1d-7f8a9b0c1d2e',
});
const item = {
  itemIndex: 0,
  mediaId: '1',
  type: 'video' as const,
  url: 'https://media.test/video.mp4',
  filenameHint: 'instagram',
};

beforeEach(() => {
  resetBrowserMocks();
  vi.mocked(loadVideoMetadata).mockReset();
});

it('waits for measured Frame duration and freezes the clamped timestamp', async () => {
  setMockMessageHandler('WATCH_INBOX_PREVIEW', () => ({ media: [item] }));
  let finish: ((value: Awaited<ReturnType<typeof loadVideoMetadata>>) => void) | undefined;
  vi.mocked(loadVideoMetadata).mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const { result } = renderHook(() => useInboxMedia(() => 'main'));
  await act(() => result.current.sync([entry]));
  act(() => result.current.actions.onToggleExportFrame(0));
  expect(result.current.runtimes[0]?.frame.status).toBe('loading');
  expect(result.current.canDownload).toBe(false);
  await act(async () => {
    finish?.({ dataUrl: 'data:video/mp4;base64,AA==', durationSeconds: 2 });
  });
  expect(result.current.canDownload).toBe(true);
  expect(result.current.selections[0]?.settings.mode).toMatchObject({
    _tag: 'FrameExport',
    timestampSeconds: 1,
  });
});

it('falls back for a failed remote Story-image preview without refetching a data URL', async () => {
  setMockMessageHandler('WATCH_INBOX_PREVIEW', () => ({
    media: [{ ...item, type: 'image', previewUrl: 'https://media.test/thumbnail.jpg' }],
  }));
  const fallback = vi.fn(() => ({ previewUrl: 'data:image/jpeg;base64,AA==' }));
  setMockMessageHandler('GET_PREVIEW_URL', fallback);
  const { result } = renderHook(() => useInboxMedia(() => 'main'));
  await act(() => result.current.sync([entry]));
  act(() => result.current.actions.onPreviewError(result.current.items[0]!));
  await waitFor(() =>
    expect(result.current.items[0]?.previewUrl).toBe('data:image/jpeg;base64,AA==')
  );
  act(() => result.current.actions.onPreviewError(result.current.items[0]!));
  expect(fallback).toHaveBeenCalledTimes(1);
});

it.each(['WATCH_NOT_FOUND', 'IG_NOT_AUTHENTICATED'] as const)(
  'discards a partial preview batch and reconciles its owner after %s',
  async code => {
    const preview = vi
      .fn()
      .mockReturnValueOnce({ media: [item] })
      .mockReturnValueOnce({
        failure: CommandFailure.make({ failure: OperationFailure.make({ code, scope: 'batch' }) }),
      });
    setMockMessageHandler('WATCH_INBOX_PREVIEW', preview);
    const reconcileOwner = vi.fn();
    const { result } = renderHook(() => useInboxMedia(() => 'main', reconcileOwner));
    const second = DiscoverySummary.make({
      ...entryDetails,
      entryId: '2b8e3d5c-2a4f-4e6b-9c1d-7f8a9b0c1d2e',
    });
    await act(() => result.current.sync([entry, second]));
    expect(preview).toHaveBeenCalledTimes(2);
    expect(reconcileOwner).toHaveBeenCalledOnce();
    expect(result.current.items).toEqual([]);
    expect(result.current.selections).toEqual([]);
    expect(result.current.canDownload).toBe(false);
  }
);

const entryAt = (n: number) =>
  DiscoverySummary.make({ ...entryDetails, entryId: `${n}b8e3d5c-2a4f-4e6b-9c1d-7f8a9b0c1d2e` });

it('keeps loaded previews and their edits when the selection grows or shrinks', async () => {
  const preview = vi.fn(() => ({ media: [item] }));
  setMockMessageHandler('WATCH_INBOX_PREVIEW', preview);
  const { result } = renderHook(() => useInboxMedia(() => 'main'));
  await act(() => result.current.sync([entryAt(1)]));
  act(() => result.current.actions.onRotate(result.current.items[0]!.index));

  await act(() => result.current.sync([entryAt(1), entryAt(2)]));
  expect(preview).toHaveBeenCalledTimes(2);
  expect(result.current.items.map(item => item.rotation ?? 0)).toEqual([90, 0]);

  await act(() => result.current.sync([entryAt(2)]));
  expect(result.current.items.map(item => item.entryId)).toEqual([entryAt(2).entryId]);
  expect(preview).toHaveBeenCalledTimes(2);

  await act(() => result.current.sync([entryAt(2), entryAt(1)]));
  expect(result.current.items.map(item => item.entryId)).toEqual([
    entryAt(2).entryId,
    entryAt(1).entryId,
  ]);
});

it('sends no further previews once one is rate limited', async () => {
  const preview = vi.fn(() => ({
    failure: CommandFailure.make({
      failure: OperationFailure.make({ code: 'IG_RATE_LIMITED', scope: 'batch' }),
    }),
  }));
  setMockMessageHandler('WATCH_INBOX_PREVIEW', preview);
  const { result } = renderHook(() => useInboxMedia(() => 'main'));
  await act(() => result.current.sync([1, 2, 3, 4, 5].map(entryAt)));
  expect(preview).toHaveBeenCalledTimes(3);
  expect(result.current.progress).toBeUndefined();
});
