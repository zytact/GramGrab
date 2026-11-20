import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttemptOperation } from '../download/attempt';
import type { OperationFailure } from '../errors/contracts';
import { WARNING_PRESENTATION } from '../errors/presentation';
import {
  normalizeBrowserDownloadFailure,
  normalizeWhatsAppCaptureFailure,
} from '../errors/normalize';
import { frameFilename } from '../frame-export/timestamp';
import {
  captureWhatsAppVisibleStatus,
  WhatsAppCaptureError,
  type WhatsAppCaptureHandle,
} from '../whatsapp/capture';
import type { ReencodeCandidate } from '../silent-video/batch';
import {
  exportWhatsAppStatus,
  whatsappExportProgressMessage,
  whatsappReencodeCandidate,
} from '../whatsapp/export';
import { whatsappExportSelection, type WhatsAppExportSelection } from '../whatsapp/mode';
import { useFrameSeekEffect } from './use-frame-seek';
import { useWhatsAppDisclosure } from './use-whatsapp-disclosure';
import { useWhatsAppFrameEdit } from './use-whatsapp-frame-edit';
import { useWhatsAppItemEdits } from './use-whatsapp-item-edits';
import {
  captured,
  capturing,
  downloading,
  editOf,
  failed,
  itemRuntimesOf,
  mediaListChoice,
  IDLE_WHATSAPP_CAPTURE,
  started,
  withDownloadProgress,
  withEdit,
  type WhatsAppCaptureState,
  type WhatsAppEdit,
  type WhatsAppOperation,
} from './whatsapp-capture-state';

function attemptOperation(
  handle: WhatsAppCaptureHandle,
  edit: WhatsAppEdit,
  operation: WhatsAppOperation,
  selection: WhatsAppExportSelection
): AttemptOperation {
  return {
    operationId: operation.operationId,
    requestId: operation.requestId,
    itemIndex: 0,
    url: edit.item.url,
    originalUrl: edit.item.url,
    originalFilename: handle.filename,
    filename: selection.filename,
    mediaType: handle.descriptor.kind === 'video' ? 'video' : 'image',
    mode: selection.mode,
    displayIndex: 0,
    ...(selection.mode === 'frame'
      ? { frameTimestampSeconds: selection.frameTimestampSeconds }
      : {}),
    ...exportModifiers(edit),
  };
}

function exportModifiers({ item }: WhatsAppEdit) {
  return {
    ...(item.rotation ? { rotation: item.rotation } : {}),
    ...(item.crop ? { crop: item.crop } : {}),
  };
}

export type ApproveReencode = (
  candidates: readonly ReencodeCandidate[]
) => Promise<ReadonlySet<string>>;

const REENCODE_DECLINED = 'reencode-declined';

async function downloadSelection(
  handle: WhatsAppCaptureHandle,
  edit: WhatsAppEdit,
  operation: WhatsAppOperation,
  onProgress: (message: string) => void,
  approveReencode: ApproveReencode
) {
  const selection = whatsappExportSelection(
    { kind: handle.descriptor.kind, edited: Object.keys(exportModifiers(edit)).length > 0 },
    edit.exportChoice,
    handle.filename,
    frameFilename(
      handle.filename.replace(/\.[^.]+$/u, ''),
      edit.exportChoice.mode === 'frame' ? edit.exportChoice.timestampSeconds : 0
    )
  );
  const operationForExport = attemptOperation(handle, edit, operation, selection);
  const candidate = await whatsappReencodeCandidate(handle, operationForExport);
  if (candidate && !(await approveReencode([candidate])).has(operationForExport.operationId))
    return REENCODE_DECLINED;
  return exportWhatsAppStatus(handle, operationForExport, (phase, progress) => {
    const message = whatsappExportProgressMessage(operationForExport, phase, progress);
    if (message) onProgress(message);
  });
}

function settledState(
  ready: Extract<WhatsAppCaptureState, { _tag: 'Ready' }>,
  result: Awaited<ReturnType<typeof downloadSelection>>
): WhatsAppCaptureState {
  if (result === REENCODE_DECLINED)
    return { ...ready, message: 'Re-encoding skipped. Change the export, or download again.' };
  if ('status' in result && result.status === 'failed')
    return failed(ready.operation, result.failure);
  return started(
    result.warning
      ? WARNING_PRESENTATION[result.warning.code]
      : 'Download started. The in-memory capture was released.'
  );
}

function captureFailure(error: unknown): OperationFailure {
  const captureError =
    error instanceof WhatsAppCaptureError ? error : new WhatsAppCaptureError('transfer-failed');
  return captureError.reason === 'download-failed' && captureError.browserCause !== undefined
    ? normalizeBrowserDownloadFailure(captureError.browserCause, 'whatsapp')
    : normalizeWhatsAppCaptureFailure(captureError.reason, captureError.shape);
}

function downloadFailure(error: unknown): OperationFailure {
  return error instanceof WhatsAppCaptureError && error.browserCause !== undefined
    ? normalizeBrowserDownloadFailure(error.browserCause, 'whatsapp')
    : normalizeWhatsAppCaptureFailure(
        error instanceof WhatsAppCaptureError ? error.reason : 'transfer-failed'
      );
}

/**
 * Owns the WhatsApp Visible Status flow: the capture state machine and the in-memory
 * capture handle, composed with the view-receipt disclosure and frame editing.
 */
export function useWhatsAppCapture({
  eligible,
  videoRefs,
  approveReencode,
}: {
  eligible: boolean;
  videoRefs: { current: Record<number, HTMLVideoElement | null> };
  approveReencode: ApproveReencode;
}) {
  const [state, setState] = useState<WhatsAppCaptureState>(IDLE_WHATSAPP_CAPTURE);
  const handleRef = useRef<WhatsAppCaptureHandle | undefined>(undefined);
  const edit = editOf(state);

  const patchEdit = useCallback((update: (edit: WhatsAppEdit) => WhatsAppEdit) => {
    setState(previous => withEdit(previous, update));
  }, []);
  const onAcknowledgeFailed = useCallback(
    () =>
      setState({
        _tag: 'Idle',
        message: 'GramGrab could not remember this acknowledgement. Try again.',
      }),
    []
  );
  const {
    disclosure,
    acknowledge,
    require: requireDisclosure,
    dismiss,
  } = useWhatsAppDisclosure({
    eligible,
    onAcknowledgeFailed,
  });
  const frameEdit = useWhatsAppFrameEdit({ edit, patchEdit, handleRef, videoRefs });
  const itemEdits = useWhatsAppItemEdits(patchEdit);
  const resetFrameDefaults = frameEdit.resetFrameDefaults;

  useEffect(
    () => () => {
      handleRef.current?.release();
      handleRef.current = undefined;
    },
    []
  );

  const capture = useCallback(async () => {
    if (disclosure !== 'acknowledged') {
      requireDisclosure();
      return;
    }
    if (state._tag === 'Capturing') return;
    const next = capturing(state);
    const operation = next.operation;
    setState(next);
    try {
      const handle = await captureWhatsAppVisibleStatus({
        operationId: operation.operationId,
        requestId: operation.requestId,
      });
      handleRef.current?.release();
      handleRef.current = handle;
      resetFrameDefaults();
      setState(captured(operation, handle));
    } catch (error) {
      setState(failed(operation, captureFailure(error)));
    }
  }, [disclosure, requireDisclosure, resetFrameDefaults, state]);

  const download = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle || state._tag !== 'Ready' || !state.edit.item.selected) return;
    const operation = state.operation;
    setState(downloading(state));
    try {
      const result = await downloadSelection(
        handle,
        state.edit,
        operation,
        message => setState(previous => withDownloadProgress(previous, message)),
        approveReencode
      );
      if (result !== REENCODE_DECLINED) handleRef.current = undefined;
      setState(settledState(state, result));
    } catch (error) {
      handleRef.current = undefined;
      setState(failed(operation, downloadFailure(error)));
    }
  }, [approveReencode, state]);

  const exportChoice = edit?.exportChoice;
  const { frameSettings, removeAudioIndexes } = useMemo(
    () => mediaListChoice(exportChoice),
    [exportChoice]
  );
  const itemRuntimes = useMemo(() => itemRuntimesOf(edit), [edit]);
  useFrameSeekEffect(frameSettings, itemRuntimes, videoRefs);

  return {
    state,
    disclosure,
    itemRuntimes,
    frameSettings,
    removeAudioIndexes,
    busy: state._tag === 'Capturing',
    failure: state._tag === 'Failed' ? state.failure : undefined,
    acknowledge,
    dismissDisclosure: dismiss,
    reviewDisclosure: requireDisclosure,
    capture,
    download,
    ...itemEdits,
    toggleFrame: frameEdit.toggleFrame,
    changeFrameTimestamp: frameEdit.changeFrameTimestamp,
    setFrameDuration: frameEdit.setFrameDuration,
    previewError: frameEdit.previewError,
    retryFrameMetadata: frameEdit.retryFrameMetadata,
  };
}
