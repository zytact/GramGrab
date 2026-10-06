import { createContext, useContext, useState } from 'react';
import { Schema } from 'effect';
import {
  DirectExport,
  FrameExport,
  Rotation,
  SilentExport,
  WatchInboxExport,
  WatchInboxRetry,
  type DiscoverySummary,
  type InboxExportOutcome,
  type WatchCommand,
  type FailureCode,
} from '@gramgrab/protocol';
import { sendMessage } from '../messaging/send.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';

const run = (command: WatchCommand) => sendMessage({ type: 'WATCH_COMMAND', command });

function canRecover(code: FailureCode) {
  const policy = FAILURE_PRESENTATION[code];
  return (
    policy.retry !== 'never' ||
    policy.actions.includes('download-original') ||
    policy.actions.includes('try-reencode')
  );
}
function applicable(outcome: InboxExportOutcome, recovery?: 'original' | 'reencode') {
  if (recovery && outcome.skipped?.length) return true;
  return outcome.failures.some(failure => {
    const policy = FAILURE_PRESENTATION[failure.code];
    return recovery === 'original'
      ? policy.actions.includes('download-original')
      : recovery === 'reencode'
        ? policy.actions.includes('try-reencode')
        : policy.retry !== 'never';
  });
}

export function useInboxExport(onChanged: () => void) {
  const [selected, setSelected] = useState<ReadonlyMap<string, DiscoverySummary>>(new Map());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, InboxExportOutcome>>(new Map());
  const [busy, setBusy] = useState(false);
  const [chosenMode, setMode] = useState<'direct' | 'frame' | 'silent'>('direct');
  const [timestamp, setTimestamp] = useState('5');
  const [rotation, setRotation] = useState('0');
  const [failure, setFailure] = useState<string>();
  const [consent, setConsent] = useState(false);
  const entries = [...selected.values()];
  const hasAvatar = entries.some(entry => entry.mediaType === 'avatar');
  const hasVideo = entries.some(
    entry => entry.mediaType === 'video' || entry.mediaType === 'sidecar'
  );
  const mode = hasAvatar || !hasVideo ? 'direct' : chosenMode;
  const failed = [...outcomes.values()].filter(
    outcome =>
      outcome.planId &&
      (outcome.failures.some(failure => canRecover(failure.code)) || outcome.skipped?.length)
  );

  const execute = async (command: WatchCommand) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const response = await run(command);
      if (response.failure?._tag === 'CommandFailure')
        setFailure(FAILURE_PRESENTATION[response.failure.failure.code].title);
      if (response.result?._tag === 'WatchInboxExportResult') {
        setOutcomes(new Map(response.result.outcomes.map(outcome => [outcome.entryId, outcome])));
        setSelected(new Map());
      }
    } catch {
      setFailure(FAILURE_PRESENTATION.DOWNLOAD_UNEXPECTED_FAILURE.title);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const download = () => {
    const seconds = Number(timestamp);
    if (mode === 'frame' && (!timestamp.trim() || !Number.isFinite(seconds) || seconds < 0)) {
      setFailure('Enter a frame timestamp of zero or more seconds.');
      return;
    }
    const requested =
      mode === 'frame'
        ? FrameExport.make({ timestampSeconds: seconds })
        : mode === 'silent'
          ? SilentExport.make({ reencode: 'forbid' })
          : DirectExport.make();
    void execute(
      WatchInboxExport.make({
        entryIds: entries.map(entry => entry.entryId),
        settings: {
          mode: requested,
          ...(rotation === '0' || hasAvatar
            ? {}
            : { rotation: Schema.decodeUnknownSync(Rotation)(Number(rotation)) }),
        },
      })
    );
  };
  const retry = (recovery?: 'original' | 'reencode') => {
    setConsent(false);
    const plans = failed
      .filter(outcome => applicable(outcome, recovery))
      .flatMap(outcome =>
        outcome.planId ? [{ entryId: outcome.entryId, planId: outcome.planId }] : []
      );
    void execute(WatchInboxRetry.make({ plans, ...(recovery ? { recovery } : {}) }));
  };
  return {
    selected,
    outcomes,
    busy,
    mode,
    setMode,
    timestamp,
    setTimestamp,
    rotation,
    setRotation,
    failure,
    consent,
    setConsent,
    entries,
    failed,
    download,
    retry,
    active: selected.size > 0 || busy || failed.length > 0,
    clear: () => {
      setSelected(new Map());
      if (!busy) setOutcomes(new Map());
    },
    toggle: (entry: DiscoverySummary) => {
      const previous = entry.manualExport;
      if (previous) setOutcomes(current => new Map(current).set(entry.entryId, previous));
      setSelected(current => {
        const next = new Map(current);
        if (!next.delete(entry.entryId)) next.set(entry.entryId, entry);
        return next;
      });
    },
  };
}

type ExportState = ReturnType<typeof useInboxExport>;
export const InboxExportContext = createContext<ExportState | undefined>(undefined);

export function useInboxSelection() {
  const value = useContext(InboxExportContext);
  if (!value) throw new Error('Inbox selection requires the Watches console.');
  return value;
}

function ExportFields({ value }: { value: ExportState }) {
  const hasVideo = value.entries.some(
    entry => entry.mediaType === 'video' || entry.mediaType === 'sidecar'
  );
  const hasAvatar = value.entries.some(entry => entry.mediaType === 'avatar');
  return (
    <div className="opt-col">
      <label className="opt-col">
        Export mode
        <select
          className="opt-input"
          aria-label="Export mode"
          value={value.mode}
          onChange={event =>
            value.setMode(
              Schema.decodeUnknownSync(Schema.Literal('direct', 'frame', 'silent'))(
                event.target.value
              )
            )
          }
          disabled={value.busy}
        >
          <option value="direct">Original</option>
          <option value="frame" disabled={!hasVideo || hasAvatar}>
            Frame at a timestamp
          </option>
          <option value="silent" disabled={!hasVideo || hasAvatar}>
            Silent video
          </option>
        </select>
      </label>
      {value.mode === 'frame' && (
        <label className="opt-col">
          Timestamp in seconds
          <input
            className="opt-input"
            aria-label="Frame timestamp in seconds"
            type="number"
            min="0"
            step="0.1"
            value={value.timestamp}
            onChange={event => value.setTimestamp(event.target.value)}
            disabled={value.busy}
          />
        </label>
      )}
      <label className="opt-col">
        Rotation
        <select
          className="opt-input"
          aria-label="Export rotation"
          value={hasAvatar ? '0' : value.rotation}
          onChange={event => value.setRotation(event.target.value)}
          disabled={value.busy || hasAvatar}
        >
          <option value="0">No rotation</option>
          <option value="90">90° clockwise</option>
          <option value="180">180°</option>
          <option value="270">270° clockwise</option>
        </select>
      </label>
      {value.mode === 'silent' && (
        <p className="opt-note">
          Tries lossless packet copying. If re-encoding is needed, you choose whether to allow its
          possible quality change.
        </p>
      )}
      {hasAvatar && <p className="opt-note">Avatar changes offer Original only.</p>}
    </div>
  );
}

function ExportRecovery({ value }: { value: ExportState }) {
  return (
    <>
      {value.failed.some(outcome => applicable(outcome)) && (
        <button className="opt-btn" disabled={value.busy} onClick={() => value.retry()}>
          Retry failed exports
        </button>
      )}
      {value.failed.some(outcome => applicable(outcome, 'original')) && (
        <button
          className="opt-btn opt-ghost"
          disabled={value.busy}
          onClick={() => value.retry('original')}
        >
          Download Original instead
        </button>
      )}
      {value.failed.some(outcome => applicable(outcome, 'reencode')) && (
        <button className="opt-btn" disabled={value.busy} onClick={() => value.setConsent(true)}>
          Review re-encoding
        </button>
      )}
      {value.consent && (
        <section
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="watch-reencode-title"
          className="opt-card"
        >
          <h3 id="watch-reencode-title">Some videos require re-encoding</h3>
          <p>Lossless packet copying is unavailable. Re-encoding may change video quality.</p>
          <button className="opt-btn opt-ghost" onClick={() => value.setConsent(false)}>
            Skip affected videos
          </button>
          <button className="opt-btn" onClick={() => value.retry('reencode')}>
            Re-encode affected videos
          </button>
        </section>
      )}
    </>
  );
}

export function InboxExportControls({ value }: { value: ExportState }) {
  const label =
    value.mode === 'frame' ? 'Frame' : value.mode === 'silent' ? 'Silent video' : 'Original';
  return (
    <div className="opt-col">
      <h2 className="opt-h2">Download selected</h2>
      <p className="opt-note">Downloads the exact recorded media. Entries stay in the inbox.</p>
      <ExportFields value={value} />
      <button
        className="opt-btn"
        disabled={value.busy || value.selected.size === 0}
        onClick={value.download}
      >
        {value.busy ? 'Starting downloads…' : `Download ${label} (${value.selected.size})`}
      </button>
      <ExportRecovery value={value} />
      {value.failure && <p className="opt-meta opt-error">{value.failure}</p>}
    </div>
  );
}
