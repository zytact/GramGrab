import { createContext, useContext, useId, useRef, useState } from 'react';
import {
  InstagramLogin,
  WatchInboxExport,
  WatchInboxRemove,
  WatchInboxRetry,
  type DiscoverySummary,
  type InboxExportOutcome,
  type WatchCommand,
  type FailureCode,
} from '@gramgrab/protocol';
import { sendMessage } from '../messaging/send.ts';
import type { WatchCommandResponse } from '../messaging/contracts.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import { InboxMediaPreview, useInboxMedia } from './inbox-media.tsx';
import { useInboxThumbnails } from './inbox-thumbnails.tsx';

/** One command per login that owns some of `items`, so each runs as its owner. */
const perLogin = <T,>(
  items: readonly T[],
  loginOf: (item: T) => InstagramLogin,
  make: (group: readonly T[]) => WatchCommand
) =>
  InstagramLogin.literals.flatMap(login => {
    const group = items.filter(item => loginOf(item) === login);
    return group.length > 0 ? [[login, make(group)] as const] : [];
  });

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

/** What one inbox action's per-login commands did together. */
function combined(responses: readonly WatchCommandResponse[]) {
  const results = responses.flatMap(response => (response.result ? [response.result] : []));
  const exports = results.flatMap(result =>
    result._tag === 'WatchInboxExportResult' ? [result] : []
  );
  const removals = results.flatMap(result =>
    result._tag === 'WatchInboxRemoveResult' ? [result] : []
  );
  return {
    failed: responses
      .flatMap(({ failure }) => (failure?._tag === 'CommandFailure' ? [failure.failure.code] : []))
      .at(-1),
    exported: exports.length > 0 ? exports.flatMap(result => result.outcomes) : undefined,
    removed:
      removals.length > 0
        ? new Set(
            removals.flatMap(result => [...result.removedEntryIds, ...result.unknownEntryIds])
          )
        : undefined,
  };
}

/** A row's own command: running, or refused before any download started. */
type RowState =
  | { readonly _tag: 'saving' }
  | { readonly _tag: 'failed'; readonly code: FailureCode };

/** Inbox selection and its commands, each run as the login `loginOf` names for an entry's Watch. */
export function useInboxExport(
  onChanged: () => void,
  loginOf: (watchId: string | undefined) => InstagramLogin
) {
  const [selected, setSelected] = useState<ReadonlyMap<string, DiscoverySummary>>(new Map());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, InboxExportOutcome>>(new Map());
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map());
  const [busy, setBusy] = useState(false);
  const thumbnails = useInboxThumbnails(loginOf);
  const watchOf = useRef(new Map<string, string>());
  const remember = (entries: readonly DiscoverySummary[]) => {
    for (const entry of entries) watchOf.current.set(entry.entryId, entry.watchId);
  };
  const entryLogin = (entryId: string) => loginOf(watchOf.current.get(entryId));
  const media = useInboxMedia(loginOf, () => {
    setSelected(new Map());
    setOutcomes(new Map());
    onChanged();
  });
  const [failure, setFailure] = useState<string>();
  const [cropConsent, setCropConsent] = useState(false);
  const entries = [...selected.values()].filter(entry => entry.unavailable === undefined);
  /** Records fresh outcomes, which replace any earlier row failure of their entries. */
  const mergeOutcomes = (exported: readonly InboxExportOutcome[]) => {
    const ids = new Set(exported.map(outcome => outcome.entryId));
    setOutcomes(
      current =>
        new Map([...current, ...exported.map(outcome => [outcome.entryId, outcome] as const)])
    );
    setRows(current => new Map([...current].filter(([id]) => !ids.has(id))));
  };
  const setRow = (entryId: string, state: RowState | undefined) =>
    setRows(current => {
      const next = new Map(current);
      if (state) next.set(entryId, state);
      else next.delete(entryId);
      return next;
    });

  const execute = async (commands: readonly (readonly [InstagramLogin, WatchCommand])[]) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const responses = [];
      for (const [login, command] of commands)
        responses.push(await sendMessage({ type: 'WATCH_COMMAND', command, login }));
      const { failed, exported, removed } = combined(responses);
      if (failed) setFailure(FAILURE_PRESENTATION[failed].title);
      if (exported) {
        mergeOutcomes(exported);
        setSelected(new Map());
        media.clearPreview();
      }
      if (removed) {
        setSelected(current => new Map([...current].filter(([id]) => !removed.has(id))));
        setOutcomes(current => new Map([...current].filter(([id]) => !removed.has(id))));
        media.clearPreview();
      }
    } catch {
      setFailure(FAILURE_PRESENTATION.DOWNLOAD_UNEXPECTED_FAILURE.title);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  /** Downloads the selection, first asking before a cropped video re-encodes. */
  const download = (approved = false) => {
    const items = media.selections;
    if (!media.canDownload) return;
    setCropConsent(!approved && media.cropsVideo);
    if (!approved && media.cropsVideo) return;
    void execute(
      perLogin(
        items,
        item => entryLogin(item.entryId),
        group =>
          WatchInboxExport.make({
            entryIds: [...new Set(group.map(item => item.entryId))],
            items: group,
          })
      )
    );
  };
  const restoreOutcomes = (entries: readonly DiscoverySummary[]) =>
    setOutcomes(current => {
      const next = new Map(current);
      for (const entry of entries) {
        if (entry.manualExport) next.set(entry.entryId, entry.manualExport);
      }
      return next;
    });
  /** Runs one entry's command on its row, leaving the selection and the inspector alone. */
  const runOnRow = async (entry: DiscoverySummary, command: WatchCommand) => {
    setRow(entry.entryId, { _tag: 'saving' });
    try {
      const response = await sendMessage({
        type: 'WATCH_COMMAND',
        command,
        login: loginOf(entry.watchId),
      });
      const { failed, exported } = combined([response]);
      setRow(entry.entryId, failed ? { _tag: 'failed', code: failed } : undefined);
      if (exported) mergeOutcomes(exported);
    } catch {
      setRow(entry.entryId, { _tag: 'failed', code: 'DOWNLOAD_UNEXPECTED_FAILURE' });
    } finally {
      onChanged();
    }
  };
  return {
    selected,
    outcomes,
    busy: busy || media.loading,
    media,
    failure,
    cropConsent,
    setCropConsent,
    entries,
    rows,
    thumbnails,
    download,
    /** Downloads one entry as Original with default modifiers. */
    downloadEntry: (entry: DiscoverySummary) =>
      void runOnRow(entry, WatchInboxExport.make({ entryIds: [entry.entryId] })),
    /** Retries one entry's failed plan, optionally through a recovery. */
    retryEntry: (entry: DiscoverySummary, planId: string, recovery?: 'original' | 'reencode') =>
      void runOnRow(
        entry,
        WatchInboxRetry.make({
          plans: [{ entryId: entry.entryId, planId }],
          ...(recovery ? { recovery } : {}),
        })
      ),
    remove: (entries: readonly DiscoverySummary[]) =>
      void execute(
        perLogin(
          entries,
          entry => loginOf(entry.watchId),
          group => WatchInboxRemove.make({ entryIds: group.map(entry => entry.entryId) })
        )
      ),
    selectAll: (entries: readonly DiscoverySummary[]) => {
      remember(entries);
      media.clearPreview();
      restoreOutcomes(entries);
      setSelected(new Map(entries.map(entry => [entry.entryId, entry])));
    },
    active: selected.size > 0 || busy || media.notices.length > 0 || !!failure,
    clear: () => {
      media.clear();
      setCropConsent(false);
      setSelected(new Map());
      setFailure(undefined);
      if (!busy) setOutcomes(new Map());
    },
    toggle: (entry: DiscoverySummary) => {
      remember([entry]);
      media.clearPreview();
      restoreOutcomes([entry]);
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

function ReencodeConsent({
  reason,
  decline,
  approve,
  onDecline,
  onApprove,
}: {
  reason: string;
  decline: string;
  approve: string;
  onDecline: () => void;
  onApprove: () => void;
}) {
  const title = useId();
  return (
    <section role="alertdialog" aria-modal="true" aria-labelledby={title} className="opt-card">
      <h3 id={title}>Some videos require re-encoding</h3>
      <p>{reason} Re-encoding may change video quality.</p>
      <button className="opt-btn opt-ghost" onClick={onDecline}>
        {decline}
      </button>
      <button className="opt-btn" onClick={onApprove}>
        {approve}
      </button>
    </section>
  );
}

/** Retry, Download Original instead and re-encoding for one entry's failed plan. */
export function RowRecovery({
  entry,
  outcome,
}: {
  entry: DiscoverySummary;
  outcome: InboxExportOutcome;
}) {
  const value = useInboxSelection();
  const [consent, setConsent] = useState(false);
  const { planId } = outcome;
  if (
    !planId ||
    !(outcome.failures.some(failure => canRecover(failure.code)) || outcome.skipped?.length)
  )
    return null;
  const disabled = value.busy || value.rows.get(entry.entryId)?._tag === 'saving';
  const retry = (recovery?: 'original' | 'reencode') => {
    setConsent(false);
    value.retryEntry(entry, planId, recovery);
  };
  return (
    <span className="opt-row">
      {applicable(outcome) && (
        <button className="opt-btn" disabled={disabled} onClick={() => retry()}>
          Retry
        </button>
      )}
      {applicable(outcome, 'original') && (
        <button className="opt-btn opt-ghost" disabled={disabled} onClick={() => retry('original')}>
          Download Original instead
        </button>
      )}
      {applicable(outcome, 'reencode') && (
        <button className="opt-btn" disabled={disabled} onClick={() => setConsent(true)}>
          Review re-encoding
        </button>
      )}
      {consent && (
        <ReencodeConsent
          reason="Lossless packet copying is unavailable."
          decline="Skip affected videos"
          approve="Re-encode affected videos"
          onDecline={() => setConsent(false)}
          onApprove={() => retry('reencode')}
        />
      )}
    </span>
  );
}

export function InboxExportControls({ value }: { value: ExportState }) {
  return (
    <div className="opt-col">
      <h2 className="opt-h2">Download selected</h2>
      <p className="opt-note">Downloads the exact recorded media. Entries stay in the inbox.</p>
      <button
        className="opt-btn"
        disabled={value.busy || value.entries.length === 0}
        onClick={() => void value.media.fetch(value.entries)}
      >
        {value.media.loading ? 'Fetching media…' : 'Fetch media'}
      </button>
      <InboxMediaPreview value={value.media} disabled={value.busy} />
      {value.entries.some(entry => entry.mediaType === 'avatar') && (
        <p className="opt-note">Avatar changes offer Original only, with rotate and crop.</p>
      )}
      <button
        className="opt-btn"
        disabled={value.busy || !value.media.canDownload}
        onClick={() => value.download()}
      >
        {value.busy
          ? 'Starting downloads…'
          : `Download selected (${value.media.selections.length})`}
      </button>
      {value.cropConsent && value.media.cropsVideo && (
        <ReencodeConsent
          reason="Cropping a video re-encodes it."
          decline="Cancel"
          approve="Re-encode cropped videos"
          onDecline={() => value.setCropConsent(false)}
          onApprove={() => value.download(true)}
        />
      )}
      {value.failure && <p className="opt-meta opt-error">{value.failure}</p>}
    </div>
  );
}
