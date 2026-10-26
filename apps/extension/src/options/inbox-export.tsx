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

/** Inbox selection and its commands, each run as the login `loginOf` names for an entry's Watch. */
export function useInboxExport(
  onChanged: () => void,
  loginOf: (watchId: string | undefined) => InstagramLogin
) {
  const [selected, setSelected] = useState<ReadonlyMap<string, DiscoverySummary>>(new Map());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, InboxExportOutcome>>(new Map());
  const [busy, setBusy] = useState(false);
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
  const [consent, setConsent] = useState(false);
  const [cropConsent, setCropConsent] = useState(false);
  const entries = [...selected.values()].filter(entry => entry.unavailable === undefined);
  const failed = [...outcomes.values()].filter(
    outcome =>
      outcome.planId &&
      (outcome.failures.some(failure => canRecover(failure.code)) || outcome.skipped?.length)
  );

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
        setOutcomes(new Map(exported.map(outcome => [outcome.entryId, outcome])));
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
  const retry = (recovery?: 'original' | 'reencode') => {
    setConsent(false);
    const plans = failed
      .filter(outcome => applicable(outcome, recovery))
      .flatMap(outcome =>
        outcome.planId ? [{ entryId: outcome.entryId, planId: outcome.planId }] : []
      );
    void execute(
      perLogin(
        plans,
        plan => entryLogin(plan.entryId),
        group => WatchInboxRetry.make({ plans: group, ...(recovery ? { recovery } : {}) })
      )
    );
  };
  return {
    selected,
    outcomes,
    busy: busy || media.loading,
    media,
    failure,
    consent,
    setConsent,
    cropConsent,
    setCropConsent,
    entries,
    failed,
    download,
    retry,
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
    active: selected.size > 0 || busy || failed.length > 0 || media.notices.length > 0 || !!failure,
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
        <ReencodeConsent
          reason="Lossless packet copying is unavailable."
          decline="Skip affected videos"
          approve="Re-encode affected videos"
          onDecline={() => value.setConsent(false)}
          onApprove={() => value.retry('reencode')}
        />
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
      <ExportRecovery value={value} />
      {value.failure && <p className="opt-meta opt-error">{value.failure}</p>}
    </div>
  );
}
