import { createContext, useContext, useState } from 'react';
import {
  WatchInboxExport,
  WatchInboxRetry,
  type DiscoverySummary,
  type InboxExportOutcome,
  type WatchCommand,
  type FailureCode,
} from '@gramgrab/protocol';
import { sendMessage } from '../messaging/send.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import { InboxMediaPreview, useInboxMedia } from './inbox-media.tsx';

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
  const media = useInboxMedia(() => {
    setSelected(new Map());
    setOutcomes(new Map());
    onChanged();
  });
  const [failure, setFailure] = useState<string>();
  const [consent, setConsent] = useState(false);
  const entries = [...selected.values()];
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
        media.clearPreview();
      }
    } catch {
      setFailure(FAILURE_PRESENTATION.DOWNLOAD_UNEXPECTED_FAILURE.title);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const download = () => {
    const items = media.selections;
    if (!media.canDownload) return;
    void execute(
      WatchInboxExport.make({
        entryIds: [...new Set(items.map(item => item.entryId))],
        items,
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
    busy: busy || media.loading,
    media,
    failure,
    consent,
    setConsent,
    entries,
    failed,
    download,
    retry,
    active: selected.size > 0 || busy || failed.length > 0 || media.notices.length > 0,
    clear: () => {
      media.clear();
      setSelected(new Map());
      if (!busy) setOutcomes(new Map());
    },
    toggle: (entry: DiscoverySummary) => {
      media.clearPreview();
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
  return (
    <div className="opt-col">
      <h2 className="opt-h2">Download selected</h2>
      <p className="opt-note">Downloads the exact recorded media. Entries stay in the inbox.</p>
      <button
        className="opt-btn"
        disabled={value.busy || value.selected.size === 0}
        onClick={() => void value.media.fetch(value.entries)}
      >
        {value.media.loading ? 'Fetching media…' : 'Fetch media'}
      </button>
      <InboxMediaPreview value={value.media} disabled={value.busy} />
      {value.entries.some(entry => entry.mediaType === 'avatar') && (
        <p className="opt-note">Avatar changes offer Original only.</p>
      )}
      <button
        className="opt-btn"
        disabled={value.busy || !value.media.canDownload}
        onClick={value.download}
      >
        {value.busy
          ? 'Starting downloads…'
          : `Download selected (${value.media.selections.length})`}
      </button>
      <ExportRecovery value={value} />
      {value.failure && <p className="opt-meta opt-error">{value.failure}</p>}
    </div>
  );
}
