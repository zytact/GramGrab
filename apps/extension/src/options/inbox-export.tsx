import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
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

/** How long a removal waits for Undo before it deletes anything. */
export const UNDO_MS = 5_000;

const withoutIds = <V,>(map: ReadonlyMap<string, V>, ids: ReadonlySet<string>) =>
  new Map([...map].filter(([id]) => !ids.has(id)));

const available = (selection: ReadonlyMap<string, DiscoverySummary>) =>
  [...selection.values()].filter(entry => entry.unavailable === undefined);

/** Files an entry would download: its children still available, or one. */
const fileCount = (entry: DiscoverySummary) =>
  entry.unavailable ? 0 : (entry.childCount ?? 1) - (entry.missingChildren ?? 0);

/**
 * Inbox selection and its commands, each run as the login `loginOf` names for an entry's Watch.
 * The selection spans Watches and views until it is cleared, downloaded or removed.
 */
export function useInboxExport(
  onChanged: () => void,
  loginOf: (watchId: string | undefined) => InstagramLogin
) {
  const [selected, setSelected] = useState<ReadonlyMap<string, DiscoverySummary>>(new Map());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, InboxExportOutcome>>(new Map());
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map());
  const [removing, setRemoving] = useState<ReadonlyMap<string, DiscoverySummary>>(new Map());
  const removal = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(removal.current), []);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const thumbnails = useInboxThumbnails(loginOf);
  const entryLogin = (entryId: string) => loginOf(selected.get(entryId)?.watchId);
  const media = useInboxMedia(loginOf, () => {
    setSelected(new Map());
    setOutcomes(new Map());
    onChanged();
  });
  const [failure, setFailure] = useState<string>();
  const [cropConsent, setCropConsent] = useState(false);
  const entries = available(selected);
  /** Records fresh outcomes, which clear an earlier row failure but keep a running row download. */
  const mergeOutcomes = (exported: readonly InboxExportOutcome[]) => {
    const ids = new Set(exported.map(outcome => outcome.entryId));
    setOutcomes(
      current =>
        new Map([...current, ...exported.map(outcome => [outcome.entryId, outcome] as const)])
    );
    setRows(
      current => new Map([...current].filter(([id, row]) => row._tag === 'saving' || !ids.has(id)))
    );
  };
  const setRowsOf = (ids: ReadonlySet<string>, state: RowState | undefined) =>
    setRows(current => {
      const next = withoutIds(current, ids);
      if (state) for (const id of ids) next.set(id, state);
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
        setEditing(false);
        media.clearPreview();
      }
      if (removed) {
        setSelected(current => withoutIds(current, removed));
        setOutcomes(current => withoutIds(current, removed));
      }
    } catch {
      setFailure(FAILURE_PRESENTATION.DOWNLOAD_UNEXPECTED_FAILURE.title);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  /** Downloads the edited selection, first asking before a cropped video re-encodes. */
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
  /** Runs one login's command on its entries' rows, leaving the inspector alone. */
  const runOnRows = async (
    group: readonly DiscoverySummary[],
    login: InstagramLogin,
    command: WatchCommand
  ) => {
    const ids = new Set(group.map(entry => entry.entryId));
    setRowsOf(ids, { _tag: 'saving' });
    try {
      const response = await sendMessage({ type: 'WATCH_COMMAND', command, login });
      const { failed, exported } = combined([response]);
      setRowsOf(ids, failed ? { _tag: 'failed', code: failed } : undefined);
      if (exported) mergeOutcomes(exported);
    } catch {
      setRowsOf(ids, { _tag: 'failed', code: 'DOWNLOAD_UNEXPECTED_FAILURE' });
    } finally {
      onChanged();
    }
  };
  /** Downloads entries as Original with default modifiers, showing progress on their rows. */
  const downloadOriginal = (targets: readonly DiscoverySummary[]) => {
    for (const login of InstagramLogin.literals) {
      const group = targets.filter(entry => loginOf(entry.watchId) === login);
      if (group.length > 0)
        void runOnRows(
          group,
          login,
          WatchInboxExport.make({ entryIds: group.map(entry => entry.entryId) })
        );
    }
  };
  /** Sets the selection; an open editor previews the new one. */
  const select = (next: ReadonlyMap<string, DiscoverySummary>) => {
    setSelected(next);
    const shown = available(next);
    if (editing && shown.length > 0) void media.fetch(shown);
    else {
      media.clear();
      setEditing(false);
    }
  };
  const commitRemoval = (pending: ReadonlyMap<string, DiscoverySummary>) => {
    setRemoving(new Map());
    void execute(
      perLogin(
        [...pending.values()],
        entry => loginOf(entry.watchId),
        group => WatchInboxRemove.make({ entryIds: group.map(entry => entry.entryId) })
      )
    );
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
    removing,
    editing,
    thumbnails,
    download,
    downloadEntry: (entry: DiscoverySummary) => downloadOriginal([entry]),
    /** Downloads every selected entry as Original and clears the selection. */
    downloadSelected: () => {
      downloadOriginal(entries);
      setSelected(new Map());
    },
    /** Retries one entry's failed plan, optionally through a recovery. */
    retryEntry: (entry: DiscoverySummary, planId: string, recovery?: 'original' | 'reencode') =>
      void runOnRows(
        [entry],
        loginOf(entry.watchId),
        WatchInboxRetry.make({
          plans: [{ entryId: entry.entryId, planId }],
          ...(recovery ? { recovery } : {}),
        })
      ),
    /** Hides entries at once and removes them once Undo has had `UNDO_MS` to stop it. */
    remove: (targets: readonly DiscoverySummary[]) => {
      const pending = new Map([
        ...removing,
        ...targets.map(entry => [entry.entryId, entry] as const),
      ]);
      setRemoving(pending);
      select(withoutIds(selected, new Set(pending.keys())));
      clearTimeout(removal.current);
      removal.current = setTimeout(() => commitRemoval(pending), UNDO_MS);
    },
    undoRemove: () => {
      clearTimeout(removal.current);
      setRemoving(new Map());
    },
    selectAll: (targets: readonly DiscoverySummary[]) =>
      select(new Map([...selected, ...targets.map(entry => [entry.entryId, entry] as const)])),
    /** Opens the editor, which loads the selection's previews. */
    edit: () => {
      setEditing(true);
      void media.fetch(entries);
    },
    closeEditor: () => {
      media.clear();
      setCropConsent(false);
      setEditing(false);
    },
    clear: () => {
      media.clear();
      setCropConsent(false);
      setEditing(false);
      setSelected(new Map());
      setFailure(undefined);
    },
    toggle: (entry: DiscoverySummary) => {
      const next = new Map(selected);
      if (!next.delete(entry.entryId)) next.set(entry.entryId, entry);
      select(next);
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
      <div className="opt-row">
        <h2 className="opt-h2 opt-grow">Edit before download</h2>
        <button className="opt-btn opt-ghost" disabled={value.busy} onClick={value.closeEditor}>
          Close
        </button>
      </div>
      <p className="opt-note">Downloads the exact recorded media. Entries stay in the inbox.</p>
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

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The selection's actions pinned under the feed, with Undo for a pending removal. */
export function InboxActionBar() {
  const value = useInboxSelection();
  const chosen = [...value.selected.values()];
  const files = chosen.reduce((total, entry) => total + fileCount(entry), 0);
  const watches = new Set(chosen.map(entry => entry.watchId)).size;
  return (
    <>
      {value.failure && !value.editing && (
        <p className="opt-meta opt-error" role="alert">
          {value.failure}
        </p>
      )}
      {chosen.length > 0 && (
        <div className="opt-bar" role="toolbar" aria-label="Selected inbox entries">
          <span className="opt-grow">
            {chosen.length} selected · {plural(files, 'file', 'files')}
            {watches > 1 && ` across ${watches} Watches`}
          </span>
          <button className="opt-btn opt-ghost" disabled={value.busy} onClick={value.clear}>
            Clear
          </button>
          <button
            className="opt-btn opt-danger"
            disabled={value.busy}
            onClick={() => value.remove(chosen)}
          >
            Remove
          </button>
          <button
            className="opt-btn opt-ghost"
            disabled={value.busy || value.editing || value.entries.length === 0}
            onClick={value.edit}
          >
            Edit before download
          </button>
          <button
            className="opt-btn"
            disabled={value.busy || files === 0}
            onClick={value.downloadSelected}
          >
            Download {files}
          </button>
        </div>
      )}
      {value.removing.size > 0 && (
        <div className="opt-toast" role="status">
          Removed {plural(value.removing.size, 'entry', 'entries')}.
          <button className="opt-btn" onClick={value.undoRemove}>
            Undo
          </button>
        </div>
      )}
    </>
  );
}
