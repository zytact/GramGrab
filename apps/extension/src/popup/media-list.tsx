import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AttemptEntry, DownloadAttempt } from '../download/attempt';
import {
  FAILURE_PRESENTATION,
  WARNING_PRESENTATION,
  presentationForFailure,
} from '../errors/presentation';
import {
  formatFrameTimestamp,
  frameTimestampAriaValue,
  maximumFrameSecond,
  type FrameExportSetting,
} from '../frame-export/timestamp';
import { distributeMasonryItems } from '../workspace/masonry';
import { resolveMediaRatio } from '../workspace/media-ratio';
import { itemRuntimeAt, type ItemRuntime, type ItemRuntimes, type MediaItem } from './media-item';

export type MediaListModel = {
  mediaItems: MediaItem[];
  itemRuntimes: ItemRuntimes;
  allSelected: boolean;
  frameExportSettings: Record<number, FrameExportSetting>;
  removeAudioIndexes: Set<number>;
  attempt: DownloadAttempt | undefined;
  emptyMessage: string;
};

export type MediaListActions = {
  onPreviewError: (item: MediaItem) => void;
  onToggle: (index: number) => void;
  onToggleAll: () => void;
  onToggleExportFrame: (index: number) => void;
  onToggleRemoveAudio: (index: number) => void;
  onChangeFrameTimestamp: (index: number, timestampSeconds: number) => void;
  onRetryFrameMetadata: (index: number) => void;
  onRetryFrameExport: (index: number) => void;
  onVideoRef: (index: number, el: HTMLVideoElement | null) => void;
  onVideoMetadata: (index: number, durationSeconds: number) => void;
  onIntrinsicDimensions: (item: MediaItem, width: number, height: number) => void;
};

function useMediaMasonry({
  mediaItems,
  workspaceMode,
  itemRuntimes,
}: {
  mediaItems: MediaItem[];
  workspaceMode: boolean;
  itemRuntimes: ItemRuntimes;
}) {
  const masonryRef = useRef<HTMLDivElement>(null);
  const [masonryWidth, setMasonryWidth] = useState(0);
  const columnCount = Math.max(1, Math.floor((masonryWidth + 12) / 232));
  const masonryColumns = useMemo(() => {
    const columnWidth = Math.max(220, (masonryWidth - (columnCount - 1) * 12) / columnCount);
    return distributeMasonryItems(mediaItems, workspaceMode ? columnCount : 1, item => {
      const intrinsic = itemRuntimes[item.index]?.intrinsic;
      const ratio = resolveMediaRatio(item.width, item.height, intrinsic?.width, intrinsic?.height);
      return columnWidth / ratio + 104;
    });
  }, [columnCount, itemRuntimes, masonryWidth, mediaItems, workspaceMode]);

  useEffect(() => {
    const element = masonryRef.current;
    if (!workspaceMode || !element || typeof ResizeObserver === 'undefined') return;
    setMasonryWidth(Math.round(element.getBoundingClientRect().width));
    const observer = new ResizeObserver(entries => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      setMasonryWidth(previous => (previous === width ? previous : width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [workspaceMode]);

  return { masonryRef, masonryColumns };
}

export function MediaListSection({
  model,
  actions,
  workspaceMode,
  disabled,
  allowSilent = true,
  showPreview = true,
  layout = 'list',
}: {
  model: MediaListModel;
  actions: MediaListActions;
  workspaceMode: boolean;
  disabled: boolean;
  allowSilent?: boolean;
  showPreview?: boolean;
  layout?: 'list' | 'hero';
}) {
  const {
    mediaItems,
    itemRuntimes,
    allSelected,
    frameExportSettings,
    removeAudioIndexes,
    attempt,
    emptyMessage,
  } = model;
  const {
    onPreviewError,
    onToggle,
    onToggleAll,
    onToggleExportFrame,
    onToggleRemoveAudio,
    onChangeFrameTimestamp,
    onRetryFrameMetadata,
    onRetryFrameExport,
    onVideoRef,
    onVideoMetadata,
    onIntrinsicDimensions,
  } = actions;
  const { masonryRef, masonryColumns } = useMediaMasonry({
    mediaItems,
    workspaceMode,
    itemRuntimes,
  });

  const renderItem = (item: MediaItem) => (
    <MediaItemRow
      key={item.index}
      item={item}
      workspaceMode={workspaceMode}
      layout={layout}
      showPreview={showPreview}
      runtime={itemRuntimeAt(itemRuntimes, item.index)}
      onError={() => onPreviewError(item)}
      onToggle={() => onToggle(item.index)}
      frameSetting={frameExportSettings[item.index]}
      removeAudio={allowSilent && removeAudioIndexes.has(item.index)}
      allowSilent={allowSilent}
      attemptEntry={attempt?.entries.find(entry => entry.operation.displayIndex === item.index)}
      disabled={disabled}
      onToggleExportFrame={() => onToggleExportFrame(item.index)}
      onToggleRemoveAudio={() => onToggleRemoveAudio(item.index)}
      onChangeFrameTimestamp={timestampSeconds =>
        onChangeFrameTimestamp(item.index, timestampSeconds)
      }
      onRetryFrameMetadata={() => onRetryFrameMetadata(item.index)}
      onRetryFrameExport={() => onRetryFrameExport(item.index)}
      onVideoRef={el => onVideoRef(item.index, el)}
      onVideoMetadata={durationSeconds => onVideoMetadata(item.index, durationSeconds)}
      onIntrinsicDimensions={(width, height) => onIntrinsicDimensions(item, width, height)}
    />
  );

  return (
    <div
      className={`ext-section${layout === 'hero' ? ' whatsapp-result-hero' : ''}`}
      style={{ flex: 1 }}
    >
      {layout === 'list' && mediaItems.length > 0 && (
        <div className="media-header">
          <span className="media-count-label" role="status" aria-live="polite">
            <strong>{mediaItems.length}</strong> item{mediaItems.length !== 1 ? 's' : ''} found
          </span>
          <label className="select-all-label">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={onToggleAll}
              disabled={disabled}
            />
            Select all
          </label>
        </div>
      )}

      <div ref={masonryRef} className={`media-list${workspaceMode ? ' workspace-media-list' : ''}`}>
        {mediaItems.length === 0 ? (
          <p className="media-empty" aria-live="polite">
            {emptyMessage}
          </p>
        ) : workspaceMode ? (
          masonryColumns.map((column, index) => (
            <div className="workspace-masonry-column" key={index}>
              {column.map(renderItem)}
            </div>
          ))
        ) : (
          mediaItems.map(renderItem)
        )}
      </div>
    </div>
  );
}

interface MediaItemRowProps {
  item: MediaItem;
  workspaceMode: boolean;
  layout: 'list' | 'hero';
  showPreview: boolean;
  runtime: ItemRuntime;
  onError: () => void;
  onToggle: () => void;
  frameSetting?: FrameExportSetting;
  removeAudio: boolean;
  allowSilent: boolean;
  onToggleExportFrame: () => void;
  onToggleRemoveAudio: () => void;
  onChangeFrameTimestamp: (timestampSeconds: number) => void;
  onRetryFrameMetadata: () => void;
  onRetryFrameExport: () => void;
  onVideoRef: (el: HTMLVideoElement | null) => void;
  onVideoMetadata: (durationSeconds: number) => void;
  onIntrinsicDimensions: (width: number, height: number) => void;
  disabled: boolean;
  attemptEntry?: AttemptEntry;
}

/** Why an item shows a placeholder instead of a preview, when the background worker said why. */
function previewFailureTitle(runtime: ItemRuntime): string {
  return runtime.previewFailure
    ? presentationForFailure(runtime.previewFailure).title
    : 'No preview available';
}

type MediaPreviewProps = Pick<
  MediaItemRowProps,
  | 'item'
  | 'workspaceMode'
  | 'layout'
  | 'runtime'
  | 'onError'
  | 'onVideoRef'
  | 'onVideoMetadata'
  | 'onIntrinsicDimensions'
>;

function MediaPreview({
  item,
  workspaceMode,
  layout,
  runtime,
  onError,
  onVideoRef,
  onVideoMetadata,
  onIntrinsicDimensions,
}: MediaPreviewProps) {
  const ratio = resolveMediaRatio(
    item.width,
    item.height,
    runtime.intrinsic?.width,
    runtime.intrinsic?.height
  );
  const previewStyle =
    workspaceMode || layout === 'hero' ? ({ '--media-ratio': ratio } as CSSProperties) : undefined;
  const failed = runtime.preview === 'failed';

  return (
    <div className="media-thumb" style={previewStyle}>
      {failed ? (
        <div className="thumb-placeholder" title={previewFailureTitle(runtime)}>
          <span className="thumb-icon">◻</span>
          <span className="thumb-placeholder-note">{previewFailureTitle(runtime)}</span>
        </div>
      ) : item.type === 'video' ? (
        <VideoPreview
          item={item}
          onError={onError}
          onVideoRef={onVideoRef}
          onVideoMetadata={onVideoMetadata}
          onIntrinsicDimensions={onIntrinsicDimensions}
        />
      ) : (
        <ImagePreview item={item} onError={onError} onIntrinsicDimensions={onIntrinsicDimensions} />
      )}
      {runtime.preview === 'loading' && !item.previewUrl && (
        <span className="thumb-loading">···</span>
      )}
    </div>
  );
}

function VideoPreview({
  item,
  onError,
  onVideoRef,
  onVideoMetadata,
  onIntrinsicDimensions,
}: Pick<
  MediaItemRowProps,
  'item' | 'onError' | 'onVideoRef' | 'onVideoMetadata' | 'onIntrinsicDimensions'
>) {
  return (
    <>
      <video
        src={item.url}
        muted
        playsInline
        onError={onError}
        ref={onVideoRef}
        onLoadedMetadata={event => {
          onIntrinsicDimensions(event.currentTarget.videoWidth, event.currentTarget.videoHeight);
          onVideoMetadata(event.currentTarget.duration);
        }}
      />
      <div className="play-overlay">
        <div className="play-triangle" />
      </div>
    </>
  );
}

function ImagePreview({
  item,
  onError,
  onIntrinsicDimensions,
}: Pick<MediaItemRowProps, 'item' | 'onError' | 'onIntrinsicDimensions'>) {
  return (
    <img
      src={item.previewUrl ?? item.url}
      alt="Preview"
      onLoad={event =>
        onIntrinsicDimensions(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
      }
      onError={onError}
    />
  );
}

// fallow-ignore-next-line complexity
function MediaControls({
  item,
  frameSetting,
  removeAudio,
  allowSilent,
  runtime,
  onToggle,
  onToggleExportFrame,
  onToggleRemoveAudio,
  onChangeFrameTimestamp,
  onRetryFrameMetadata,
  onRetryFrameExport,
  disabled,
  failureDescriptionId,
}: Pick<
  MediaItemRowProps,
  | 'item'
  | 'frameSetting'
  | 'removeAudio'
  | 'allowSilent'
  | 'runtime'
  | 'onToggle'
  | 'onToggleExportFrame'
  | 'onToggleRemoveAudio'
  | 'onChangeFrameTimestamp'
  | 'onRetryFrameMetadata'
  | 'onRetryFrameExport'
  | 'disabled'
> & { failureDescriptionId?: string }) {
  const frame = runtime.frame;
  const duration = frame.durationSeconds;
  const maximum = duration === undefined ? undefined : maximumFrameSecond(duration);
  const timestampSeconds = frameSetting?.timestampSeconds ?? 0;
  return (
    <div className="media-controls">
      {item.type === 'video' && (
        <div className="frame-export-control" onClick={event => event.stopPropagation()}>
          <label className="frame-toggle" title="Export a JPEG frame on download">
            <input
              type="checkbox"
              checked={frameSetting?.enabled ?? false}
              onChange={onToggleExportFrame}
              disabled={disabled}
              className="frame-toggle-checkbox"
            />
            Frame
          </label>
          {allowSilent && (
            <label className="frame-toggle" title="Download a silent MP4">
              <input
                type="checkbox"
                checked={removeAudio}
                onChange={onToggleRemoveAudio}
                disabled={disabled}
                className="frame-toggle-checkbox"
              />
              Remove audio
            </label>
          )}
          {frameSetting?.enabled && (
            <div className="frame-timestamp-row">
              <input
                type="range"
                min="0"
                max={maximum ?? 0}
                step="1"
                value={timestampSeconds}
                disabled={disabled || frame.status !== 'ready' || maximum === undefined}
                aria-label={`Frame timestamp for item ${String(item.index + 1).padStart(2, '0')}`}
                aria-valuetext={frameTimestampAriaValue(timestampSeconds)}
                onChange={event => onChangeFrameTimestamp(Number(event.currentTarget.value))}
              />
              <output>{formatFrameTimestamp(timestampSeconds)}</output>
              {frame.status === 'loading' && <span>Loading…</span>}
              {frame.status === 'failed' && (
                <button
                  type="button"
                  className="frame-retry"
                  onClick={frame.durationSeconds ? onRetryFrameExport : onRetryFrameMetadata}
                  disabled={disabled}
                >
                  Retry
                </button>
              )}
              {frame.error && <span className="frame-error">{frame.error}</span>}
              {frame.warning && <span>{frame.warning}</span>}
            </div>
          )}
        </div>
      )}
      <input
        className="item-checkbox"
        type="checkbox"
        checked={item.selected}
        onChange={onToggle}
        onClick={event => event.stopPropagation()}
        disabled={disabled}
        aria-describedby={failureDescriptionId}
      />
    </div>
  );
}

// fallow-ignore-next-line complexity
function MediaItemRow(props: MediaItemRowProps) {
  const {
    item,
    workspaceMode,
    layout,
    showPreview,
    runtime,
    onError,
    onToggle,
    frameSetting,
    removeAudio,
    allowSilent,
    onToggleExportFrame,
    onToggleRemoveAudio,
    onChangeFrameTimestamp,
    onRetryFrameMetadata,
    onRetryFrameExport,
    onVideoRef,
    onVideoMetadata,
    onIntrinsicDimensions,
    disabled,
    attemptEntry,
  } = props;
  const num = String(item.index + 1).padStart(2, '0');

  return (
    <div
      className={`media-item${item.selected ? ' selected' : ''}`}
      onClick={() => !disabled && onToggle()}
    >
      <span className="item-number">{num}</span>

      {showPreview && (
        <MediaPreview
          item={item}
          workspaceMode={workspaceMode}
          layout={layout}
          runtime={runtime}
          onError={onError}
          onVideoRef={onVideoRef}
          onVideoMetadata={onVideoMetadata}
          onIntrinsicDimensions={onIntrinsicDimensions}
        />
      )}

      <div className="item-info">
        <span className={`item-type-badge ${item.type}`}>{item.type}</span>
        {item.history?.downloaded && (
          <span
            className="item-type-badge"
            aria-label={`Downloaded ${new Date(item.history.latestDownloadedAt ?? Date.now()).toLocaleString()}`}
          >
            Downloaded
          </span>
        )}
        <span className="item-filename">{item.filenameHint}</span>
        {item.creatorUsername && <span className="item-creator">@{item.creatorUsername}</span>}
        {attemptEntry?.outcome.status === 'pending' && (
          <span className="download-item-status pending">
            {attemptEntry.outcome.phase
              ? `${attemptEntry.outcome.phase} ${Math.round((attemptEntry.outcome.progress ?? 0) * 100)}%`
              : attemptEntry.operation.mode === 'frame'
                ? 'Exporting…'
                : 'Starting…'}
          </span>
        )}
        {attemptEntry?.outcome.status === 'started' && (
          <span className="download-item-status accepted">
            {attemptEntry.operation.mode === 'frame' ? 'Frame exported' : 'Download started'}
          </span>
        )}
        {attemptEntry?.outcome.status === 'started' && attemptEntry.outcome.warning && (
          <span className="download-item-status warning">
            {WARNING_PRESENTATION[attemptEntry.outcome.warning.code]}
          </span>
        )}
        {attemptEntry?.outcome.status === 'failed' && (
          <span className="download-item-status failed" id={`download-result-${item.index}`}>
            {FAILURE_PRESENTATION[attemptEntry.outcome.failure.code].title}:{' '}
            {FAILURE_PRESENTATION[attemptEntry.outcome.failure.code].explanation}{' '}
            <code>{attemptEntry.outcome.failure.code}</code>
          </span>
        )}
        {attemptEntry?.outcome.status === 'skipped' && (
          <span className="download-item-status skipped">
            Skipped: re-encoding was declined. <code>{attemptEntry.outcome.code}</code>
          </span>
        )}
      </div>

      <MediaControls
        item={item}
        frameSetting={frameSetting}
        removeAudio={removeAudio}
        allowSilent={allowSilent}
        runtime={runtime}
        onToggle={onToggle}
        onToggleExportFrame={onToggleExportFrame}
        onToggleRemoveAudio={onToggleRemoveAudio}
        onChangeFrameTimestamp={onChangeFrameTimestamp}
        onRetryFrameMetadata={onRetryFrameMetadata}
        onRetryFrameExport={onRetryFrameExport}
        disabled={disabled}
        failureDescriptionId={
          attemptEntry?.outcome.status === 'failed' ? `download-result-${item.index}` : undefined
        }
      />
    </div>
  );
}
