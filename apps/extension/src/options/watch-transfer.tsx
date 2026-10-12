import { useRef, useState } from 'react';
import { Either, Schema } from 'effect';
import {
  UNATTENDED_DISCLOSURE,
  WatchesExport,
  WatchesFile,
  WatchesImport,
  type WatchCommand,
  type WatchDefinition,
  type WatchSummary,
  type WatchesImportResult,
} from '@gramgrab/protocol';
import type { WatchCommandResponse } from '../messaging/contracts.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import { STORE_BUDGET_BYTES } from '../watch/contracts.ts';
import { ACTION_LABEL, KIND_LABEL } from './copy.ts';
import { askToNotify } from './notify-permission.ts';

const decodeFile = Schema.decodeUnknownEither(WatchesFile);

/**
 * The Watches file in `file`, or undefined when this build cannot read it as one. A file larger
 * than the whole Watch store is not parsed.
 */
async function readWatchesFile(file: File): Promise<WatchesFile | undefined> {
  if (file.size > STORE_BUDGET_BYTES) return undefined;
  try {
    return Either.getOrUndefined(decodeFile(JSON.parse(await file.text())));
  } catch {
    return undefined;
  }
}

function saveWatchesFile(file: WatchesFile) {
  const link = document.createElement('a');
  link.href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(file, undefined, 2))}`;
  link.download = `gramgrab-watches-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
}

const watchCount = (count: number) => `${count} ${count === 1 ? 'Watch' : 'Watches'}`;
const accountCount = (count: number) => `${count} ${count === 1 ? 'account' : 'accounts'}`;

function Definitions({ title, watches }: { title: string; watches: readonly WatchDefinition[] }) {
  if (watches.length === 0) return null;
  return (
    <>
      <span className="opt-label">
        {title} ({watches.length})
      </span>
      {watches.map(watch => (
        <div key={watch.accountId} className="opt-line opt-account-text">
          <span>@{watch.username}</span>
          <span className="opt-meta">
            {[
              `Account ID ${watch.accountId}`,
              watch.kinds.map(kind => KIND_LABEL[kind]).join(', '),
              watch.actions.map(action => ACTION_LABEL[action]).join(', '),
              ...(watch.enabled ? [] : ['Paused']),
            ].join(' · ')}
          </span>
        </div>
      ))}
    </>
  );
}

type Send = (command: WatchCommand) => Promise<WatchCommandResponse>;

function ExportWatches({ count, onSend }: { count: number; onSend: Send }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="opt-add">
      <p className="opt-note">
        Saves each Watch of this Instagram login to a file: the account, what to watch for, what to
        do, and whether it is paused. The file holds no media, no inbox, and nothing a check found.
      </p>
      <button
        className="opt-btn opt-primary"
        disabled={count === 0 || busy}
        onClick={() => {
          setBusy(true);
          void onSend(WatchesExport.make()).then(response => {
            setBusy(false);
            if (response.result?._tag === 'WatchesExportResult')
              saveWatchesFile(response.result.file);
          });
        }}
      >
        Export {watchCount(count)}
      </button>
    </div>
  );
}

function ImportPreview({
  file,
  watches,
  onSend,
  onImported,
}: {
  file: WatchesFile;
  watches: readonly WatchSummary[];
  onSend: Send;
  onImported: (result: WatchesImportResult) => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const alreadyWatched = (definition: WatchDefinition) =>
    watches.some(watch => watch.accountId === definition.accountId);
  const toAdd = file.watches.filter(definition => !alreadyWatched(definition));
  return (
    <form
      className="opt-add"
      onSubmit={event => {
        event.preventDefault();
        askToNotify(toAdd.flatMap(definition => definition.actions));
        setBusy(true);
        void onSend(WatchesImport.make({ file, acceptUnattended: accepted })).then(response => {
          setBusy(false);
          if (response.result?._tag === 'WatchesImportResult') onImported(response.result);
        });
      }}
    >
      <Definitions title="Will be added" watches={toAdd} />
      <Definitions title="Already watched, skipped" watches={file.watches.filter(alreadyWatched)} />
      {toAdd.length === 0 ? (
        <p className="opt-note">Nothing to add. You already watch every account in this file.</p>
      ) : (
        <>
          <p className="opt-note">
            Usernames above come from the file. Importing asks Instagram for each account by its ID
            and uses the username it has now. Each added Watch starts fresh: its first check records
            what is already there and acts on nothing.
          </p>
          <label className="opt-option opt-disclosure">
            <input
              type="checkbox"
              checked={accepted}
              onChange={event => setAccepted(event.target.checked)}
            />
            <span>{UNATTENDED_DISCLOSURE}</span>
          </label>
          <button className="opt-btn opt-primary" disabled={!accepted || busy}>
            {busy ? 'Importing…' : `Import ${watchCount(toAdd.length)}`}
          </button>
        </>
      )}
    </form>
  );
}

function ImportOutcome({ result }: { result: WatchesImportResult }) {
  const { added, unconfirmed, stopped } = result;
  return (
    <>
      <p className="opt-banner">Added {watchCount(added.length)}.</p>
      {unconfirmed.length > 0 && (
        <p className="opt-banner opt-banner-error">
          Instagram did not confirm {accountCount(unconfirmed.length)}, so no Watch was added for{' '}
          {unconfirmed.length === 1 ? 'it' : 'them'}: account ID {unconfirmed.join(', ')}.
        </p>
      )}
      {stopped && (
        <p className="opt-banner opt-banner-error">
          <strong>{FAILURE_PRESENTATION[stopped.code].title}.</strong> The import stopped with{' '}
          {accountCount(stopped.remaining)} left. Choose the file again later to add the rest.
        </p>
      )}
    </>
  );
}

type Chosen =
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'file'; readonly file: WatchesFile }
  | { readonly kind: 'imported'; readonly result: WatchesImportResult };

function ImportWatches({ watches, onSend }: { watches: readonly WatchSummary[]; onSend: Send }) {
  const [chosen, setChosen] = useState<Chosen>();
  const [imports, setImports] = useState(0);
  const selection = useRef(0);
  return (
    <div className="opt-add">
      <p className="opt-note">
        Adds the Watches in an exported file to the Instagram login signed in here. An account you
        already watch is skipped, and its Watch stays as it is.
      </p>
      <input
        key={imports}
        type="file"
        accept="application/json,.json"
        aria-label="Watches file"
        onChange={event => {
          const current = ++selection.current;
          const selected = event.target.files?.[0];
          setChosen(undefined);
          if (!selected) return;
          void readWatchesFile(selected).then(file => {
            if (current === selection.current)
              setChosen(file ? { kind: 'file', file } : { kind: 'unreadable' });
          });
        }}
      />
      {chosen?.kind === 'unreadable' && (
        <p className="opt-banner opt-banner-error">
          This is not a Watches file this version of GramGrab can read. Nothing was imported.
        </p>
      )}
      {chosen?.kind === 'imported' && <ImportOutcome result={chosen.result} />}
      {chosen?.kind === 'file' && (
        <ImportPreview
          file={chosen.file}
          watches={watches}
          onSend={onSend}
          onImported={result => {
            setImports(count => count + 1);
            setChosen({ kind: 'imported', result });
          }}
        />
      )}
    </div>
  );
}

/** Exports the login's Watches to a file, and previews a file before importing it. */
export function WatchTransfer({
  watches,
  onSend,
}: {
  watches: readonly WatchSummary[];
  onSend: Send;
}) {
  return (
    <>
      <h1 className="opt-h1">Export and import</h1>
      <h2 className="opt-h2">Export</h2>
      <ExportWatches count={watches.length} onSend={onSend} />
      <h2 className="opt-h2">Import</h2>
      <ImportWatches watches={watches} onSend={onSend} />
    </>
  );
}
