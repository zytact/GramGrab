import type { ReactNode } from 'react';
import type { OperationFailure } from '../errors/contracts';
import { presentationForFailure } from '../errors/presentation';
import { LoadingButtonLabel } from './loading-button-label';
import { MediaListSection, type MediaListActions, type MediaListModel } from './media-list';
import type { useWhatsAppCapture } from './use-whatsapp-capture';
import type { WhatsAppDisclosureState } from './use-whatsapp-disclosure';
import { editOf, type WhatsAppCaptureState } from './whatsapp-capture-state';

type WhatsAppCapture = ReturnType<typeof useWhatsAppCapture>;

type PanelProps = {
  eligible: boolean;
  capture: WhatsAppCapture;
  disabled: boolean;
  onVideoRef: (index: number, el: HTMLVideoElement | null) => void;
  onCopyDiagnostics: (trigger: HTMLButtonElement) => void;
};

export function WhatsAppStatusPanel({
  eligible,
  capture,
  disabled,
  onVideoRef,
  onCopyDiagnostics,
}: PanelProps) {
  if (!eligible)
    return (
      <section className="ext-section whatsapp-capture-section" aria-labelledby="whatsapp-title">
        <h1 id="whatsapp-title">Open WhatsApp Web</h1>
        <p className="whatsapp-capture-copy">
          Open web.whatsapp.com, then open the photo or video Status you want to capture.
        </p>
      </section>
    );

  const edit = editOf(capture.state);
  if (!edit)
    return (
      <WhatsAppCaptureSection
        capture={capture}
        disabled={disabled}
        onCopyDiagnostics={onCopyDiagnostics}
      />
    );

  const model: MediaListModel = {
    mediaItems: [edit.item],
    itemRuntimes: capture.itemRuntimes,
    allSelected: edit.item.selected,
    frameExportSettings: edit.frameSetting ? { 0: edit.frameSetting } : {},
    removeAudioIndexes: edit.removeAudio ? new Set([0]) : new Set(),
    attempt: undefined,
    emptyMessage: '',
  };
  const actions: MediaListActions = {
    onPreviewError: capture.previewError,
    onToggle: capture.toggleItem,
    onToggleAll: capture.toggleItem,
    onToggleExportFrame: capture.toggleFrame,
    onToggleRemoveAudio: capture.toggleRemoveAudio,
    onChangeFrameTimestamp: (_index, timestampSeconds) =>
      capture.changeFrameTimestamp(timestampSeconds),
    onRetryFrameMetadata: capture.retryFrameMetadata,
    onRetryFrameExport: () => {},
    onVideoRef,
    onVideoMetadata: (_index, durationSeconds) => capture.setFrameDuration(durationSeconds),
    onIntrinsicDimensions: () => {},
  };
  const isDownloading = capture.state._tag === 'Downloading';
  return (
    <>
      <section className="ext-section whatsapp-capture-section" aria-labelledby="whatsapp-title">
        <h1 id="whatsapp-title">Visible Status captured</h1>
        <p className="whatsapp-capture-copy">
          This is the one photo or video that was visible when you captured it. It stays in memory
          until the download starts, the edit lease expires, or you close GramGrab.
        </p>
      </section>
      <MediaListSection
        model={model}
        actions={actions}
        workspaceMode={false}
        disabled={disabled}
        allowSilent
        showPreview
        layout="hero"
      />
      <div className="ext-section">
        <button
          type="button"
          className="btn"
          onClick={() => void capture.download()}
          disabled={!edit.item.selected || disabled}
          aria-busy={isDownloading}
        >
          {isDownloading ? (
            <LoadingButtonLabel>Downloading…</LoadingButtonLabel>
          ) : (
            'Download Visible Status'
          )}
        </button>
      </div>
    </>
  );
}

function WhatsAppCaptureSection({
  capture,
  disabled,
  onCopyDiagnostics,
}: Omit<PanelProps, 'eligible' | 'onVideoRef'>) {
  if (capture.disclosure === 'acknowledged')
    return (
      <WhatsAppCaptureReady
        capture={capture}
        disabled={disabled}
        onCopyDiagnostics={onCopyDiagnostics}
      />
    );
  return (
    <WhatsAppCaptureShell title="Before using WhatsApp Status">
      <WhatsAppViewReceiptDisclosure
        disclosure={capture.disclosure}
        onAcknowledge={() => void capture.acknowledge()}
        onDismiss={capture.dismissDisclosure}
        onReview={capture.reviewDisclosure}
      />
    </WhatsAppCaptureShell>
  );
}

function WhatsAppCaptureReady({
  capture,
  disabled,
  onCopyDiagnostics,
}: Omit<PanelProps, 'eligible' | 'onVideoRef'>) {
  const state = capture.state;
  const presentation = capture.failure ? presentationForFailure(capture.failure) : undefined;
  return (
    <WhatsAppCaptureShell title={presentation?.title ?? 'Capture the Visible Status'}>
      <p className="whatsapp-capture-copy">{state.message}</p>
      <p className="whatsapp-capture-note">
        One click captures only the already-visible photo or video. The capture stays in memory for
        this download and is then released.
      </p>
      {canCaptureAgain(state, presentation) && (
        <button
          type="button"
          className="btn"
          onClick={() => void capture.capture()}
          disabled={disabled || state._tag === 'Ready' || state._tag === 'Downloading'}
          aria-busy={state._tag === 'Capturing'}
        >
          {captureButtonLabel(state)}
        </button>
      )}
      {capture.failure && (
        <WhatsAppCaptureFailure
          failure={capture.failure}
          canCopyDiagnostics={presentation?.actions.includes('copy-diagnostics') ?? false}
          onCopyDiagnostics={onCopyDiagnostics}
        />
      )}
    </WhatsAppCaptureShell>
  );
}

/** After a failure, the presentation's recovery policy decides whether a retry is offered. */
function canCaptureAgain(
  state: WhatsAppCaptureState,
  presentation: ReturnType<typeof presentationForFailure> | undefined
): boolean {
  if (state._tag !== 'Failed') return true;
  if (!presentation?.actions.includes('retry-operation')) return false;
  return presentation.retry !== 'once' || state.operation.manualRetryCount === 0;
}

function captureButtonLabel(state: WhatsAppCaptureState) {
  switch (state._tag) {
    case 'Capturing':
      return <LoadingButtonLabel>Capturing…</LoadingButtonLabel>;
    case 'Downloading':
      return <LoadingButtonLabel>Downloading…</LoadingButtonLabel>;
    case 'Started':
      return 'Capture another Visible Status';
    case 'Failed':
      return 'Capture Visible Status again';
    default:
      return 'Capture Visible Status';
  }
}

function WhatsAppCaptureFailure({
  failure,
  canCopyDiagnostics,
  onCopyDiagnostics,
}: {
  failure: OperationFailure;
  canCopyDiagnostics: boolean;
  onCopyDiagnostics: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <div className="status-message error" role="status">
      <code>{failure.code}</code>
      {canCopyDiagnostics && (
        <button
          type="button"
          className="workspace-secondary"
          onClick={event => onCopyDiagnostics(event.currentTarget)}
        >
          Copy diagnostics
        </button>
      )}
    </div>
  );
}

function WhatsAppCaptureShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      className="ext-section whatsapp-capture-section"
      aria-labelledby="whatsapp-capture-title"
    >
      <h1 id="whatsapp-capture-title">{title}</h1>
      {children}
    </section>
  );
}

function WhatsAppViewReceiptDisclosure({
  disclosure,
  onAcknowledge,
  onDismiss,
  onReview,
}: {
  disclosure: WhatsAppDisclosureState;
  onAcknowledge: () => void;
  onDismiss: () => void;
  onReview: () => void;
}) {
  if (disclosure === 'checking')
    return <p className="whatsapp-capture-copy">Preparing the capture notice…</p>;
  if (disclosure === 'dismissed')
    return (
      <div className="whatsapp-view-receipt-disclosure">
        <p className="whatsapp-capture-copy">
          Review the view-receipt notice before capturing a Visible Status.
        </p>
        <button type="button" className="btn" onClick={onReview}>
          Review notice
        </button>
      </div>
    );
  return (
    <div className="whatsapp-view-receipt-disclosure" role="status">
      <p className="whatsapp-capture-copy">
        WhatsApp controls view receipts. GramGrab does not provide anonymous viewing.
      </p>
      <div className="quality-dialog-actions">
        <button type="button" className="workspace-secondary" onClick={onDismiss}>
          Not now
        </button>
        <button type="button" className="btn" onClick={onAcknowledge}>
          Continue
        </button>
      </div>
    </div>
  );
}
