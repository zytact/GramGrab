import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
import { swapsAxes } from '../rotation/contracts';
import type { Crop } from '../crop/contracts';
import { CropOverlay, CropToolbar } from './crop-selector';
import { itemRuntimeAt, type ItemRuntime, type ItemRuntimes, type MediaItem } from './media-item';
import { StoryExpiry } from './story-expiry';

export type MediaListModel = {
  mediaItems: MediaItem[];
  itemRuntimes: ItemRuntimes;
  allSelected: boolean;
  frameExportSettings: Record<number, FrameExportSetting>;
  removeAudioIndexes: ReadonlySet<number>;
  attempt: DownloadAttempt | undefined;
  emptyMessage: string;
  /** The item whose crop selector is open. */
  cropIndex?: number;
};

export type MediaListActions = {
  onPreviewError: (item: MediaItem) => void;
  onToggle: (index: number) => void;
  /** Absent where outputs cannot be rotated, which hides the control. */
  onRotate?: (index: number) => void;
  /** Absent where outputs cannot be cropped, which hides the control. */
  onCrop?: (index: number) => void;
  onChangeCrop?: (index: number, crop: Crop | undefined) => void;
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

/** The width-to-height ratio an item shows at, after its rotation. */
function displayRatio(item: MediaItem, runtime: ItemRuntime | undefined): number {
  const ratio = resolveMediaRatio(
    item.width,
    item.height,
    runtime?.intrinsic?.width,
    runtime?.intrinsic?.height
  );
  return swapsAxes(item.rotation) ? 1 / ratio : ratio;
}

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
    return distributeMasonryItems(
      mediaItems,
      workspaceMode ? columnCount : 1,
      item => columnWidth / displayRatio(item, itemRuntimes[item.index]) + 104
    );
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
  canRotate = () => true,
  canCrop = item => item.type === 'image',
}: {
  model: MediaListModel;
  actions: MediaListActions;
  workspaceMode: boolean;
  disabled: boolean;
  allowSilent?: boolean;
  showPreview?: boolean;
  layout?: 'list' | 'hero';
  canRotate?: (item: MediaItem) => boolean;
  canCrop?: (item: MediaItem) => boolean;
}) {
  const {
    mediaItems,
    itemRuntimes,
    allSelected,
    frameExportSettings,
    removeAudioIndexes,
    attempt,
    emptyMessage,
    cropIndex,
  } = model;
  const {
    onPreviewError,
    onToggle,
    onRotate,
    onCrop,
    onChangeCrop,
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
  const attemptEntries = useMemo(() => {
    const byDisplayIndex = new Map<number, AttemptEntry>();
    for (const entry of attempt?.entries ?? [])
      if (!byDisplayIndex.has(entry.operation.displayIndex))
        byDisplayIndex.set(entry.operation.displayIndex, entry);
    return byDisplayIndex;
  }, [attempt]);

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
      onRotate={onRotate && canRotate(item) ? () => onRotate(item.index) : undefined}
      onCrop={onCrop && canCrop(item) ? () => onCrop(item.index) : undefined}
      cropEditing={cropIndex === item.index}
      onChangeCrop={crop => onChangeCrop?.(item.index, crop)}
      frameSetting={frameExportSettings[item.index]}
      removeAudio={allowSilent && removeAudioIndexes.has(item.index)}
      allowSilent={allowSilent}
      attemptEntry={attemptEntries.get(item.index)}
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
              className="select-all-checkbox"
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
  onRotate?: () => void;
  onCrop?: () => void;
  cropEditing: boolean;
  onChangeCrop: (crop: Crop | undefined) => void;
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
> & { children?: ReactNode };

function MediaPreview({
  item,
  workspaceMode,
  layout,
  runtime,
  onError,
  onVideoRef,
  onVideoMetadata,
  onIntrinsicDimensions,
  children,
}: MediaPreviewProps) {
  const previewStyle =
    workspaceMode || layout === 'hero'
      ? ({ '--media-ratio': displayRatio(item, runtime) } as CSSProperties)
      : undefined;
  const failed = runtime.preview === 'failed';

  return (
    <div className="media-thumb" style={previewStyle} data-rotation={item.rotation}>
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
      {children}
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
        className="media-preview"
        src={item.url}
        muted
        playsInline
        preload="metadata"
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
      className="media-preview"
      src={item.previewUrl ?? item.url}
      alt="Preview"
      loading="lazy"
      decoding="async"
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
  onRotate,
  onCrop,
  cropToolbar,
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
  | 'onRotate'
  | 'onCrop'
  | 'onToggleExportFrame'
  | 'onToggleRemoveAudio'
  | 'onChangeFrameTimestamp'
  | 'onRetryFrameMetadata'
  | 'onRetryFrameExport'
  | 'disabled'
> & { failureDescriptionId?: string; cropToolbar?: ReactNode }) {
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
      {onRotate && (
        <button
          type="button"
          className="frame-toggle rotate-toggle"
          aria-pressed={item.rotation !== undefined}
          aria-label={`Rotate item ${String(item.index + 1).padStart(2, '0')} clockwise, now ${item.rotation ?? 0} degrees`}
          title="Rotate 90° clockwise before download"
          onClick={event => {
            event.stopPropagation();
            onRotate();
          }}
          disabled={disabled}
        >
          ↻ {item.rotation ?? 0}°
        </button>
      )}
      {onCrop && (
        <button
          type="button"
          className="frame-toggle crop-toggle"
          aria-pressed={item.crop !== undefined}
          aria-label={`Crop item ${String(item.index + 1).padStart(2, '0')}${item.crop ? ', cropped' : ''}`}
          title="Crop before download"
          onClick={event => {
            event.stopPropagation();
            onCrop();
          }}
          disabled={disabled}
        >
          Crop
        </button>
      )}
      {cropToolbar}
      <input
        className="item-checkbox"
        type="checkbox"
        aria-label={`Select item ${String(item.index + 1).padStart(2, '0')}`}
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
    onRotate,
    onCrop,
    cropEditing,
    onChangeCrop,
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
  // A turn swaps the frame's sides, so an aspect lock only holds for the turn it was set at.
  const [lock, setLock] = useState<{ ratio: number; rotation: MediaItem['rotation'] }>();
  const aspect = lock && lock.rotation === item.rotation ? lock.ratio : undefined;
  const setAspect = (ratio: number | undefined) =>
    setLock(ratio === undefined ? undefined : { ratio, rotation: item.rotation });
  const editing = cropEditing && !disabled && onCrop !== undefined;
  const frameRatio = displayRatio(item, runtime);

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
        >
          {workspaceMode && (editing || item.crop) && (
            <CropOverlay
              crop={item.crop}
              editing={editing}
              frameRatio={frameRatio}
              aspect={aspect}
              label={`Crop area for item ${num}. Arrow keys move it; Shift with arrow keys resizes it.`}
              onChange={onChangeCrop}
            />
          )}
        </MediaPreview>
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
        <StoryExpiry expiresAt={item.expiresAt} />
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
        onRotate={onRotate}
        onCrop={onCrop}
        cropToolbar={
          editing && (
            <CropToolbar
              crop={item.crop}
              frameRatio={frameRatio}
              aspect={aspect}
              onAspect={setAspect}
              onChange={onChangeCrop}
              onDone={() => {
                setAspect(undefined);
                onCrop();
              }}
            />
          )
        }
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
