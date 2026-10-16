import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import {
  ASPECT_PRESETS,
  FULL_FRAME,
  fitAspect,
  moveCrop,
  resizeCrop,
  stepCrop,
  type Crop,
  type CropHandle,
} from '../crop/contracts';

const HANDLES: readonly CropHandle[] = ['nw', 'ne', 'sw', 'se'];

const ARROWS: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
};

type Drag =
  | { kind: 'move'; startX: number; startY: number; start: Crop }
  | { kind: 'resize'; handle: CropHandle };

/**
 * The crop rectangle drawn over a workspace preview. It dims what the crop drops, and while
 * `editing` it takes pointer drags on its body and corners plus arrow keys.
 */
export function CropOverlay({
  crop,
  editing,
  frameRatio,
  aspect,
  label,
  onChange,
}: {
  crop: Crop | undefined;
  editing: boolean;
  frameRatio: number;
  aspect: number | undefined;
  label: string;
  onChange: (crop: Crop) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag>(undefined);
  const area = crop ?? FULL_FRAME;
  const lock = aspect === undefined ? undefined : { ratio: aspect, frameRatio };

  const pointAt = (event: PointerEvent) => {
    const bounds = frameRef.current!.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };
  };
  const startDrag = (event: PointerEvent, next: Drag) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = next;
  };
  const continueDrag = (event: PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const point = pointAt(event);
    onChange(
      current.kind === 'move'
        ? moveCrop(current.start, point.x - current.startX, point.y - current.startY)
        : resizeCrop(area, current.handle, point, lock)
    );
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const arrow = ARROWS[event.key];
    if (!arrow) return;
    event.preventDefault();
    onChange(stepCrop(area, arrow, event.shiftKey, lock));
  };

  return (
    <div
      ref={frameRef}
      className={`crop-frame${editing ? ' editing' : ''}`}
      style={{ '--media-ratio': frameRatio } as CSSProperties}
      onClick={event => editing && event.stopPropagation()}
    >
      <div
        className="crop-rect"
        style={{
          left: `${area.x * 100}%`,
          top: `${area.y * 100}%`,
          width: `${area.width * 100}%`,
          height: `${area.height * 100}%`,
        }}
        {...(editing
          ? {
              tabIndex: 0,
              role: 'group',
              'aria-label': label,
              onKeyDown,
              onPointerDown: (event: PointerEvent) => {
                const point = pointAt(event);
                startDrag(event, { kind: 'move', startX: point.x, startY: point.y, start: area });
              },
              onPointerMove: continueDrag,
              onPointerUp: () => (drag.current = undefined),
            }
          : {})}
      >
        {editing &&
          HANDLES.map(handle => (
            <span
              key={handle}
              className={`crop-handle ${handle}`}
              onPointerDown={event => startDrag(event, { kind: 'resize', handle })}
              onPointerMove={continueDrag}
              onPointerUp={() => (drag.current = undefined)}
            />
          ))}
      </div>
    </div>
  );
}

/** Aspect presets, reset and done for the crop being edited. */
export function CropToolbar({
  crop,
  frameRatio,
  aspect,
  onAspect,
  onChange,
  onDone,
}: {
  crop: Crop | undefined;
  frameRatio: number;
  aspect: number | undefined;
  onAspect: (aspect: number | undefined) => void;
  onChange: (crop: Crop | undefined) => void;
  onDone: () => void;
}) {
  return (
    <div
      className="crop-toolbar"
      role="toolbar"
      aria-label="Crop"
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        className="frame-toggle"
        aria-pressed={aspect === undefined}
        onClick={() => onAspect(undefined)}
      >
        Free
      </button>
      {ASPECT_PRESETS.map(preset => (
        <button
          key={preset.label}
          type="button"
          className="frame-toggle"
          aria-pressed={aspect === preset.ratio}
          onClick={() => {
            onAspect(preset.ratio);
            onChange(fitAspect(crop ?? FULL_FRAME, preset.ratio, frameRatio));
          }}
        >
          {preset.label}
        </button>
      ))}
      <button
        type="button"
        className="frame-toggle"
        onClick={() => {
          onAspect(undefined);
          onChange(undefined);
        }}
      >
        Reset
      </button>
      <button type="button" className="frame-toggle" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
