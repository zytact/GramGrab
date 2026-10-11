import { useState } from 'react';
import { buildWatchDiagnostics, type WatchDiagnosticsInput } from '../errors/diagnostics.ts';
import { browser } from '../lib/browser.ts';

/** Shows the structural-only report before the person copies it. */
export function DiagnosticsPreview({ failure }: Pick<WatchDiagnosticsInput, 'failure'>) {
  const [json, setJson] = useState<string>();
  if (!json)
    return (
      <button
        className="opt-btn"
        onClick={() =>
          setJson(
            buildWatchDiagnostics({
              extensionVersion: browser.runtime.getManifest().version ?? '0.0.0',
              userAgent: navigator.userAgent,
              failure,
            })
          )
        }
      >
        Preview diagnostics
      </button>
    );
  return (
    <div className="opt-col">
      <p className="opt-note">
        This contains only the extension version, capture time, normalized browser details, and the
        structured failure code with the rule a check broke. It excludes accounts, usernames, media,
        and anything saved in your Watches.
      </p>
      <pre className="diagnostics-preview">{json}</pre>
      <button className="opt-btn" onClick={() => void navigator.clipboard.writeText(json)}>
        Copy diagnostics
      </button>
    </div>
  );
}
