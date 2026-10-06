# Watches may access Instagram without a request in the moment

Until now, every Instagram request GramGrab made served an operation the person had just asked for. A Watch instead runs Watch checks about twice a day while the browser is open, from the extension background worker, using the person's signed-in session. We allow this unattended access only for Watches the person added after acknowledging a disclosure, and only for the Instagram login that created them.

The person accepts the disclosure each time they add a Watch. On the options page that is a confirmation step. In the CLI it is the `--accept-unattended` flag on `gramgrab watch add`. The disclosure says that Instagram may treat the automated traffic as unusual and could limit or flag the account. A fixed 12-hour Watch round, request spacing, an hourly cap, and a shared 429 pause bound the traffic. Person-initiated work always goes first.

Watch state stays on the device in `storage.local` under an allowlisted schema: identifiers, publication and discovery times, check status, and action outcomes. It never holds media bytes, signed or preview URLs, captions, names, or session material. A Posts traversal cursor lives only in `storage.session`. Shareable diagnostics gain only a closed media-kind field.

## Considered options

- **A CLI or native-host daemon.** It would make Watch checks independent of the browser, but it would need the session outside the browser and a resident process. That is far more reach than this feature is worth, so it is out of scope.
- **A content script in an open Instagram tab.** It would make the traffic look like page activity, but the manifest deliberately declares no content scripts, and the Watch would depend on a tab the person might not have open.
- **Consent on every Watch check.** This would keep the "requested in the moment" rule intact, but a Watch that needs a click on every check isn't a Watch.

## Consequences

- `alarms` becomes a required permission. `notifications` is optional and is requested when notify is first selected.
- The `cookies` permission now covers reading `csrftoken` for any Instagram request that requires it, not only Instants.
- Firefox still declares no data collection, because Watch state never leaves the device.
