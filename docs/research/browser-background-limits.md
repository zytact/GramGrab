# Browser limits for unattended Watch checks

Research for [#185](https://github.com/zytact/GramGrab/issues/185), under map [#183](https://github.com/zytact/GramGrab/issues/183). Researched 2026-10-01. Targets are Chromium (MV3 service worker) and Firefox 109+ (MV3 event page), matching `apps/extension/scripts/manifest.mjs`.

Each claim carries a label.

- **Documented** - stated on an official docs page (Chrome for Developers or MDN).
- **Source** - read from Chromium or Firefox source on `main`. These show what the code does today, not a promise, and Firefox `main` may be newer than 109.
- **Inferred** - a conclusion drawn from the above. Nobody ran it in a live browser. Items to confirm live are listed at the end.

## Short answer

- **Alarms** work in both browsers. Chrome allows a 30 second minimum period (1 minute before Chrome 120). Firefox has no minimum in its source. Firefox alarms do not survive a browser restart, so the extension must recreate them on startup. Chrome alarms survive restarts today, and Chrome 150 adds an explicit flag. Both browsers clear alarms on an extension update, so the extension must also recreate them on install and update.
- **Worker lifetime.** Both browsers stop the background after 30 seconds idle by default. Chrome also stops a single event after 5 minutes. Firefox has no documented hard cap. A Watch check must save progress as it goes and survive termination.
- **Notifications.** Chrome supports buttons (max 2) and click handling. Firefox supports only a basic notification with title, message and icon. Firefox ignores `buttons` and never fires `onButtonClicked`. Click handlers wake the background in both browsers.
- **Unattended downloads.** `downloads.download` needs no user gesture in either browser. Chrome still shows a save dialog when the user turned on "Ask where to save each file", even with `saveAs: false`. Firefox honors `saveAs: false` over that setting.
- **Runner window.** `windows.create` has no documented gesture requirement in either browser, so a background check can open `runner.html`. A Watch check does not need it, since it only fetches metadata and downloads direct URLs.

## Alarms

| | Chromium | Firefox 109+ |
| --- | --- | --- |
| Minimum period | 30 s, "may delay them an arbitrary amount more". Before Chrome 120 it was 1 minute. Unpacked extensions are exempt. Documented ([1], [2]) | No minimum in `Alarm` source. A period below 30 s is allowed. Source ([13]). MDN states no minimum ([3]) |
| Persist across browser restart | Documented: the `persistAcrossSessions` flag is Chrome 150+ and "defaults to true to match historical behavior". Older versions "can be unpredictable" ([1]) | Documented: "Alarms do not persist across browser sessions" ([4]). Source: alarms live in an in-memory `Map` with `nsITimer` timers, nothing is stored ([13]) |
| Persist across extension update | Documented: with `persistAcrossSessions: true` an alarm persists "until the extension updates". Alarms are cleared "whenever the extension updates" ([1]) | Source: `onShutdown` clears every alarm ([13]). Inferred: update, reload and disable clear them |
| Fires while browser is closed | Not documented. Inferred: no, there is no process | Not documented. Inferred: no, timers live in the browser process |
| After sleep | Documented: "Alarms continue to run while a device is sleeping... an alarm will not wake up a device. When the device wakes up, any missed alarms will fire." A repeating alarm fires once, then reschedules from wake time ([1]) | Not documented. Source: timers are one-shot `nsITimer` and a period re-arms after firing ([13]) |
| Wakes a stopped background | Documented: incoming events revive the service worker ([5]) | Source: `onAlarm` is a persistent event, so a listener registered at top level survives event page suspension ([13], [14]) |
| Same name | Documented: creating an alarm with an existing name replaces it ([2]). Behaves the same in Firefox source ([13]) | Source ([13]) |

Chrome's own advice for versions without `persistAcrossSessions`: "it is best to make sure important alarms exists each time your service worker starts up" ([1]). That advice also fits Firefox.

An alarm that already fired late keeps no memory of what it missed. Both browsers can deliver an alarm late or not at all across a restart, so a Watch check cannot assume it ran on schedule. It should store a `lastCheckedAt` and decide from that.

## Background lifetime

### Chromium service worker

- Terminates after 30 seconds idle. Receiving an event or calling an extension API resets the timer. Documented ([5]).
- Terminates when a single event or API call takes longer than 5 minutes. Documented ([5]).
- Terminates when a `fetch()` response takes more than 30 seconds to arrive. Documented ([5]).
- An open native messaging port also resets the timer (Chrome 105+). Documented ([5]).
- Global variables are lost on termination. Documented ([5]).
- `runtime.onStartup` fires when a profile first starts. It does not fire for an incognito profile. Documented ([6]). A service worker that wants to run at startup needs a top-level `onStartup` listener.
- Startup quote ([5]): "When a user profile starts, the `runtime.onStartup` event fires but no service worker events are invoked."

### Firefox event page

- A non-persistent background script loads for an event and unloads when idle. In MV3 it is always non-persistent. Documented ([7]).
- Listeners must be registered synchronously at top level. Global state is lost on unload, use `storage.session` or `storage.local`. Documented ([7]).
- The idle timeout pref `extensions.background.idle.timeout` defaults to 30000 ms and is clamped to 100 ms to 5 min. Source ([15]).
- Parent API calls from the background reset the idle timer. Source ([15]).
- A pending listener promise resets the timer once. A second expiry terminates the page. Source ([15]). Inferred: an awaited `fetch` that makes no extension API call has roughly 30 to 60 seconds before termination.
- An open native messaging port or a pending `sendNativeMessage` exempts the page from termination. Source, with a comment saying this mirrors Chrome ([15]).
- A devtools toolbox attached to the extension also blocks termination. Source ([15]). Remember this when testing: it hides idle-termination bugs.
- `runtime.onStartup` fires only on browser start, not on install or enable. For an event page to run at least once per session the extension "must add a listener to `runtime.onStartup`". Documented ([8]).

### What this means for GramGrab

`apps/extension/src/native-bridge.ts` calls `browser.runtime.connectNative` at load and on `onStartup`. When the native host is installed, that port keeps the background alive in both browsers (documented in Chrome, source in Firefox). Inferred: users with the CLI installed would see a long-lived background, users without it would see the 30 second idle behavior. Watch checks must work in the second case.

A check that fetches several accounts can pass 30 seconds. The check should:

1. Persist its seen-set and `lastCheckedAt` after each account, not at the end.
2. Call an extension API (such as `storage.local.set`) between steps. That resets the idle timer in both browsers.
3. Assume it can be killed at any time and resume from stored state on the next alarm.

## Notifications

| | Chromium | Firefox 109+ |
| --- | --- | --- |
| Permission | `notifications`. Install warning "Display notifications" ([9], [10]). Adding it in an update disables the extension until the user accepts ([11]) | `notifications`. MDN says only that the browser "may inform the user at install time" ([12]) |
| Runtime permission prompt | None in the API. `getPermissionLevel()` returns `granted` or `denied` ([9]). `onPermissionLevelChanged` fires on change | None documented. Inferred: no API to read OS-level state |
| Templates | `basic`, `image`, `list`, `progress` ([9]) | `basic` only. Firefox supports only `type`, `title`, `message` and `iconUrl` ([16]) |
| Buttons | Up to 2 ([9]). Button icons not visible on macOS ([9]) | Not supported. Source: `onButtonClicked` is `ignoreEvent`, so it never fires ([17]) |
| `requireInteraction`, `silent` | `requireInteraction` Chrome 50+, `silent` Chrome 70+ ([9]) | `requireInteraction`, `contextMessage`, `priority`, `eventTime`, `imageUrl`, `items`, `progress` are all unsupported ([16]) |
| Click handling | `onClicked` for the body, `onButtonClicked` for buttons, `onClosed` ([9]) | `onClicked`, `onClosed`, `onShown` ([17], [18]) |
| Wakes a stopped background | Documented: events revive the worker ([5]) | Source: `onClicked`, `onClosed` and `onShown` are persistent events ([17]) |
| Rapid creation | Not documented | Documented: calling `create()` repeatedly in quick succession "may end up not displaying any notification at all" ([18]) |
| Reusing an id | Replaces the existing notification | Documented: clears the existing notification ([18]) |

Chrome rejects a `create()` without `iconUrl`, `message` and `title` ([9]). Firefox makes `iconUrl` optional ([16]).

Implications for the spec: a notify action that needs "Download" or "Open workspace" buttons is Chrome only. A cross-browser design should make the click on the notification body the primary action and use at most a summary per check, not one notification per item, because of the Firefox rapid-creation warning. Click handlers must be top-level listeners.

## Downloads without a gesture

- **Gesture requirement.** `downloads.download` needs none in either browser. Chromium source: `DownloadsDownloadFunction` has no gesture check. The only gesture check in `downloads_api.cc` is on `downloads.open` ([19]). Firefox `ext-downloads.js` has no gesture check either ([20]). GramGrab already calls `downloads.download` from the background for CLI commands (`apps/extension/src/background.ts`, `downloadItem`), so this works in practice for both targets.
- **Chromium and "Ask where to save each file".**
  - Documented: `saveAs: true` shows a file chooser. The docs say nothing about what `saveAs: false` does against the user setting ([21]).
  - Source: `save_as` only calls `set_prompt` when it is set ([19]). With `false` the download gets target disposition overwrite, not prompt. `DownloadTargetDeterminer::NeedsConfirmation` then falls through to "For everything else, prompting is controlled by the PromptForDownload pref" ([22]).
  - Inferred: with the setting on, a background download from an extension still opens the dialog, even with `saveAs: false`. The dialog blocks until the user answers, so an unattended auto-download sits pending, and the dialog can surface long after the check. The code also prompts on a resumed download whose path is unwritable or out of space ([22]).
  - Exceptions in the same function: no prompt when the download path is managed by policy, or for transient downloads ([22]).
- **Firefox.** Documented: omitting `saveAs` follows the "Always ask you where to save files" preference (`browser.download.useDownloadDir`). The `saveAs` option is ignored on Firefox for Android, and `true` raises an error there ([23]). Source: an explicit `saveAs: false` skips the picker regardless of the pref. The code only reads the pref when `saveAs` is not specified ([20]). So GramGrab's existing `saveAs: false` is safe for unattended use in Firefox.
- **Not verified.** Whether Chrome adds any "download multiple files" gate to extension downloads. No evidence found in the extension API source, and web-page limiter code was not traced.

Implication for the spec: a Chromium auto-download action cannot promise silence. The options page should say so, and the action may need a pre-flight check. There is no extension API to read the pref, so this is a documented limitation, not something to detect.

## Opening the runner document without a gesture

- `windows.create` has no documented gesture requirement in Chrome ([24]) or Firefox ([25]). GramGrab already opens `runner.html` this way in `getRunner` (`focused: false`, `state: 'minimized'`, `type: 'popup'`) when a CLI command arrives with no popup open, so the pattern is exercised without a gesture today.
- `minimized` cannot be combined with `left`, `top`, `width` or `height` in either browser ([24], [25]). `getRunner` already complies.
- Firefox honors `focused: false` ("the currently focused window will stay focused") ([25]).
- The runner window is visible to the user (taskbar entry, possibly a flash on some window managers). Not documented either way. Inferred from the minimized popup design. Needs a live look on Linux, Windows and macOS.
- Chrome offers an alternative, `chrome.offscreen`. It needs the `offscreen` permission, Chrome 109+, supports one document at a time, and exposes only `runtime` APIs ([26]). It has no Firefox equivalent, so it would split the runner into two code paths. It also needs a documented `Reason` that fits frame extraction and silent re-encode.
- **A Watch check does not need the runner.** The runner exists for frame extraction and silent-video re-encode (AGENTS.md). Metadata fetch, `downloads.download` of a direct CDN URL, and a Workspace draft handoff all run in the background. Unattended Watch actions should stay on that path and not open a window.

## Implications summary for the Watch spec

1. Use alarms for periodic checks, with a period of a few minutes at least. The 30 second Chrome floor is not the constraint.
2. Register `onAlarm`, `onStartup` and `onInstalled` at top level. Each handler calls `alarms.get(name)` and creates the alarm when missing. This covers the Firefox restart loss and both browsers' update clear.
3. Treat `onStartup` as the catch-up trigger (the map already requires this). Compare `lastCheckedAt` to the period instead of trusting the alarm to have fired.
4. Persist state between accounts and use extension API calls to keep the background alive. Do not rely on the native bridge port.
5. Notify with a basic notification and a body click, with buttons as a Chromium-only extra. One notification per check.
6. Auto-download is silent in Firefox. In Chromium it depends on a setting the extension cannot read.
7. Keep Watch actions off the runner.
8. The `notifications` permission adds a Chrome install warning and disables the extension on update until accepted. Check whether to make it an optional permission. This was not researched.

## Still to confirm live

- Chromium: a background download with `saveAs: false` while "Ask where to save each file" is on. Expect a dialog.
- Firefox: an alarm created in the event page still fires after the page unloads, and is gone after a browser restart.
- Both: alarm handler timing against the 30 second idle limit while a long `fetch` chain is running.
- Whether the minimized runner popup is visible or steals focus on each desktop OS.

## Sources

Docs and source pages fetched 2026-10-01. Source links point at `main`.

1. [chrome.alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
2. [chrome.alarms.create semantics, Chrome 120 note](https://developer.chrome.com/docs/extensions/reference/api/alarms) and [MDN alarms.create](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms/create)
3. [MDN alarms.create](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms/create)
4. [MDN alarms](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms)
5. [Extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
6. [chrome.runtime onStartup and onInstalled](https://developer.chrome.com/docs/extensions/reference/api/runtime)
7. [MDN background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)
8. [MDN runtime.onStartup](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onStartup)
9. [chrome.notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications)
10. [Chrome permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)
11. [Chrome permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)
12. [MDN manifest permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions)
13. [Firefox `ext-alarms.js`](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/extensions/parent/ext-alarms.js)
14. [Firefox source docs, implementing an event](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/events.html)
15. [Firefox `ext-backgroundPage.js`](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/extensions/parent/ext-backgroundPage.js) and [`ExtensionParent.sys.mjs`](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/extensions/ExtensionParent.sys.mjs)
16. [MDN NotificationOptions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/notifications/NotificationOptions)
17. [Firefox `ext-notifications.js`](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/extensions/parent/ext-notifications.js)
18. [MDN notifications.create](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/notifications/create)
19. [Chromium `downloads_api.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/extensions/api/downloads/downloads_api.cc)
20. [Firefox `ext-downloads.js`](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/extensions/parent/ext-downloads.js)
21. [chrome.downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)
22. [Chromium `download_target_determiner.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/download/download_target_determiner.cc)
23. [MDN downloads.download](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/download)
24. [chrome.windows](https://developer.chrome.com/docs/extensions/reference/api/windows)
25. [MDN windows.create](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/create)
26. [chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
