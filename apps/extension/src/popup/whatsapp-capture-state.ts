import { createOperationId, createRequestId } from '../download/contracts';
import type { OperationFailure } from '../errors/contracts';
import { presentationForFailure } from '../errors/presentation';
import type { FrameExportSetting } from '../frame-export/timestamp';
import type { WhatsAppCaptureHandle } from '../whatsapp/capture';
import type { FrameRuntime, MediaItem } from './media-item';

export type WhatsAppOperation = {
  readonly operationId: ReturnType<typeof createOperationId>;
  readonly requestId: ReturnType<typeof createRequestId>;
  readonly manualRetryCount: number;
};

/** The export choices a person can make while a capture is held in memory. */
export type WhatsAppEdit = {
  readonly item: MediaItem;
  readonly frameSetting?: FrameExportSetting;
  readonly frameRuntime?: FrameRuntime;
  readonly removeAudio: boolean;
  readonly previewFailed: boolean;
};

/**
 * The WhatsApp capture flow as one value: a failure exists only in `Failed`, an editable
 * capture only in `Ready` and `Downloading`, and an operation only once one has started.
 */
export type WhatsAppCaptureState =
  | { readonly _tag: 'Idle'; readonly message: string }
  | { readonly _tag: 'Capturing'; readonly message: string; readonly operation: WhatsAppOperation }
  | {
      readonly _tag: 'Ready';
      readonly message: string;
      readonly operation: WhatsAppOperation;
      readonly edit: WhatsAppEdit;
    }
  | {
      readonly _tag: 'Downloading';
      readonly message: string;
      readonly operation: WhatsAppOperation;
      readonly edit: WhatsAppEdit;
    }
  | { readonly _tag: 'Started'; readonly message: string }
  | {
      readonly _tag: 'Failed';
      readonly message: string;
      readonly operation: WhatsAppOperation;
      readonly failure: OperationFailure;
    };

type CaptureStateOf<Tag extends WhatsAppCaptureState['_tag']> = Extract<
  WhatsAppCaptureState,
  { _tag: Tag }
>;

export const IDLE_WHATSAPP_CAPTURE: WhatsAppCaptureState = {
  _tag: 'Idle',
  message: 'Capture the photo or video Visible Status currently open in WhatsApp Web.',
};

function failureMessage(failure: OperationFailure): string {
  const presentation = presentationForFailure(failure);
  return `${presentation.title}. ${presentation.explanation}`;
}

/** A manual retry after a failure keeps the operation identity and counts the attempt. */
export function capturing(state: WhatsAppCaptureState): CaptureStateOf<'Capturing'> {
  const operation: WhatsAppOperation =
    state._tag === 'Failed'
      ? {
          operationId: state.operation.operationId,
          requestId: createRequestId(),
          manualRetryCount: state.operation.manualRetryCount + 1,
        }
      : { operationId: createOperationId(), requestId: createRequestId(), manualRetryCount: 0 };
  return { _tag: 'Capturing', message: 'Reading the Visible Status…', operation };
}

export function captured(
  operation: WhatsAppOperation,
  handle: WhatsAppCaptureHandle
): WhatsAppCaptureState {
  const descriptor = handle.descriptor;
  return {
    _tag: 'Ready',
    message: 'Visible Status captured. Choose an export to start the download.',
    operation,
    edit: {
      item: {
        index: 0,
        type: descriptor.kind === 'video' ? 'video' : 'image',
        url: handle.snapshot.objectUrl(),
        filenameHint: 'visible-status',
        selected: true,
        width: descriptor.width,
        height: descriptor.height,
      },
      ...(descriptor.kind === 'video' ? { frameRuntime: { status: 'idle' as const } } : {}),
      removeAudio: false,
      previewFailed: false,
    },
  };
}

export function failed(
  operation: WhatsAppOperation,
  failure: OperationFailure
): WhatsAppCaptureState {
  return { _tag: 'Failed', message: failureMessage(failure), operation, failure };
}

export function started(message: string): WhatsAppCaptureState {
  return { _tag: 'Started', message };
}

export function downloading(state: CaptureStateOf<'Ready'>): CaptureStateOf<'Downloading'> {
  return { ...state, _tag: 'Downloading' };
}

/** Progress copy only ever replaces the message of the download it belongs to. */
export function withDownloadProgress(
  state: WhatsAppCaptureState,
  message: string
): WhatsAppCaptureState {
  return state._tag === 'Downloading' ? { ...state, message } : state;
}

export function withEdit(
  state: WhatsAppCaptureState,
  update: (edit: WhatsAppEdit) => WhatsAppEdit
): WhatsAppCaptureState {
  return state._tag === 'Ready' || state._tag === 'Downloading'
    ? { ...state, edit: update(state.edit) }
    : state;
}

export function editOf(state: WhatsAppCaptureState): WhatsAppEdit | undefined {
  return state._tag === 'Ready' || state._tag === 'Downloading' ? state.edit : undefined;
}
