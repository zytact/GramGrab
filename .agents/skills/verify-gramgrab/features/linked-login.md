# Linked login

One browser profile can hold one linked second Instagram login (Beta, Chromium
only). The popup, workspace, Watches page, and CLI can act as it, so a person
can fetch and watch private accounts only their second account can see.
`docs/adr/0007-linked-second-instagram-login.md` records the design and
`docs/instagram-privacy.md` the stored-state contract.

## Sub-features

- Link: the Watches page copies the Instagram cookies of an open Incognito
  window, confirms that account with the viewer query, and refuses it when it
  is the main login. Refusals render under `.opt-login-switch`, one per
  `LinkRefusalReason` in `src/options/login-switch.tsx`.
- Unlink: deletes `linked-instagram-login` from `storage.local` and the session
  rule. A Linked tab sends the page back to Main.
- Routing: a linked request carries `gg_login=linked` and `credentials: 'omit'`.
  A `declarativeNetRequest` session rule that matches the marker, the
  `instagram.com` request domain, and `tabIds: [-1]` sets its `Cookie` header.
  The worker installs the rule again on start.
- Cookie upkeep: `webRequest.onHeadersReceived` absorbs `Set-Cookie` from marked
  worker responses into the stored copy and the rule.
- Separate ledgers: `instagram-requests` for main, `instagram-requests.linked`
  for linked. A 429 on one never pauses the other.
- Ended session: a viewer query that finds no linked viewer marks the record
  `ended`, pauses its Watches behind one `IG_LINKED_LOGIN_ENDED` attention item,
  and shows `Linked (signed out)`. Linking the same account again resumes them.

## How to get to it (user POV)

1. On the browser's extensions page, turn on Allow in Incognito for GramGrab.
2. Open an Incognito window and sign in to the second Instagram account there.
3. Open the Watches page. Under `LOGINS BETA`, click `Link this login`. The
   notice reads `Linked @<username>.` The Incognito window may close; logging
   out of it ends the linked session.
4. The Watches page gets one tab per login (`?login=linked` for the second). The
   popup and workspace get a `Login` select (`#instagram-login`) next to Fetch.
   Tabs and options read `@<username>`, or `Main` and `Linked` until the worker
   answers `LOGIN_NAMES`. A signed-out linked login reads `Linked (signed out)`.
5. The CLI takes `--login main|linked` on `inspect`, `export`, `instants`,
   `history redownload`, and `watch` commands.

Firefox has no `.opt-login-switch` and no picker.

## Driving it with the harness

Prerequisites, in order. Each is a real gate, not a flake:

- An Instagram session in the main profile and a second account the person
  signs in to themselves. Typing a person's credentials is never the agent's job.
- A target only the linked login can see: a private account the second account
  follows and the main one does not. Without it, popup, CDN, and Watch rows
  prove routing but not visibility.
- Incognito access. It lives in the persistent profile, so turning it on once
  holds across `cleanup.sh` and `launch.sh`: the worker read `true` after a
  relaunch with doctor passing. Read `chrome.extension.isAllowedIncognitoAccess()`
  in the worker before linking anyway.

Turning on Incognito access from a driven page reloads the unpacked extension,
and the reload leaves it `DISABLED` with `unsupportedDeveloperExtension`. Run
both calls from the extensions page, then doctor before driving again:

```bash
node $D open "chrome://extensions/?id=$GRAMGRAB_EXT_ID"
node $D eval "chrome://extensions/?id=$GRAMGRAB_EXT_ID" \
  "chrome.developerPrivate.updateExtensionConfiguration({extensionId:'$GRAMGRAB_EXT_ID',incognitoAccess:true}).then(()=>'ok')"
node $D eval "chrome://extensions/?id=$GRAMGRAB_EXT_ID" \
  "new Promise(r=>chrome.management.setEnabled('$GRAMGRAB_EXT_ID',true,()=>r(chrome.runtime.lastError?.message||'ok')))"
node .agents/skills/verify-gramgrab/scripts/doctor.mjs
node $D eval js/background.js "chrome.extension.isAllowedIncognitoAccess()"   # true
```

Clicking the `#allow-incognito` toggle through `eval` does nothing; it needs a
trusted event. Open the Incognito window from the worker, then hand the window
to the person to sign in. The verify browser is headed on the developer's
display, so a person working remotely needs a remote desktop to it:

```bash
node $D eval js/background.js \
  "chrome.windows.create({incognito:true,url:'https://www.instagram.com/accounts/login/'}).then(w=>w.incognito)"
```

Fingerprint the main `sessionid` before linking and compare after the run.
Print a truncated hash only:

```bash
node $D eval js/background.js "new Promise(r=>chrome.cookies.get({url:'https://www.instagram.com',name:'sessionid'},async c=>r(c?[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(c.value)))].slice(0,6).map(b=>b.toString(16).padStart(2,'0')).join(''):'none')))"
```

The refusal states need no second account and send no Instagram request. Open
an Incognito window with no Instagram tab, click `Link this login`, and read
`.opt-login-switch`, then close every Incognito window again.
`chrome.windows.getAll` rejects an `incognito` filter, so filter the result:

```bash
node $D eval js/background.js \
  "chrome.windows.create({incognito:true,url:'about:blank'}).then(w=>String(w.incognito))"
node $D eval js/background.js \
  "chrome.windows.getAll().then(ws=>Promise.all(ws.filter(w=>w.incognito).map(w=>chrome.windows.remove(w.id)))).then(r=>String(r.length))"
```

Link and unlink from the Watches page with `drive.mjs click` on the
`.opt-login-switch button` whose text is `Link this login` or `Unlink`. After
linking, prove the two logins differ without printing either ID:

```bash
node $D eval js/background.js "Promise.all([chrome.storage.session.get(null),chrome.storage.local.get('linked-instagram-login')]).then(([s,l])=>JSON.stringify({differ:s['watch-viewer']?.accountId!==s['watch-viewer.linked']?.accountId,linkedVerified:s['watch-viewer.linked']?.accountId===l['linked-instagram-login']?.accountId}))"
```

Read the session rule's condition, never its action: the action holds the
linked cookies.

```bash
node $D eval js/background.js "chrome.declarativeNetRequest.getSessionRules().then(rs=>JSON.stringify(rs.map(r=>({id:r.id,condition:r.condition}))))"
```

Fetch as the linked login in both entry points: select `linked` in
`#instagram-login`, type the linked-only Post URL into `#source-url`, click
`.fetch-row button`, then select one item and download it. `drive.mjs` has no
select command, so set the picker the way React reads it:

```bash
node $D eval popup.html "(()=>{const s=document.querySelector('#instagram-login');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'linked');s.dispatchEvent(new Event('change',{bubbles:true}));return s.value})()"
```

Over the CLI:

```bash
node apps/cli/bin/gramgrab.mjs inspect "$LINKED_ONLY_POST" --login linked --json
node apps/cli/bin/gramgrab.mjs export "$LINKED_ONLY_POST" --login linked --json
node apps/cli/bin/gramgrab.mjs inspect "$LINKED_ONLY_POST" --json; echo "exit=$?"   # main
```

For a linked Watch, open `options.html?login=linked`, add the linked-only
account, and follow the Check now recipe in [Watches](./watches.md#check-now)
under that tab. Read both ledgers before and after. The Add Watch username
field has no `type` attribute, so select it as `input`, not `input[type=text]`.
Adding the Watch spends linked requests of its own for the preview and baseline.

## What proves it works

- Link: the notice starts `Linked @`, the tabs appear named by `@username`, `linked-instagram-login`
  exists, and the viewer probe reads `{"differ":true,"linkedVerified":true}`.
- Refusal: each refusal stores nothing and names its next step. Without
  Incognito access it reads `Allow GramGrab in Incognito on the browser's
  extensions page, then link again.` With access and no Incognito window open,
  it starts `No Incognito window is open.` With an Incognito window that is not
  signed in to Instagram, `about:blank` included, it starts `Your Incognito
  window is not signed in to Instagram.` Only an open Incognito window has a
  second cookie store, so `chrome.cookies.getAllCookieStores()` in the worker
  reads `["0"]` without one and `["0","1"]` with one.
- Rule: rule 2 has `urlFilter` `gg_login=linked`, `requestDomains`
  `["instagram.com"]`, and `tabIds` `[-1]`. Rule 1 is the Origin rule every
  build installs, and it stays after linking.
- Fetch: the linked-only Post lists its items as linked, and the same URL as
  main fails. A private Post the main login cannot see reads
  `IG_RESPONSE_SHAPE_UNKNOWN` in the popup and exits 1 over the CLI. The download lands in `$GRAMGRAB_VERIFY_DOWNLOADS`
  with a non-zero size; CDN URLs on `fbcdn.net` need no cookies.
- Watch: the linked check finishes, and only `instagram-requests.linked` gains
  attempts.
- Main session: the `sessionid` hash is the same before and after.
- Unlink: the record and the session rule are both gone, and the picker hides.

## Gotchas

- Evidence from this feature names two accounts. Blur both usernames before a
  screenshot leaves `.local/`, and keep cookies, account IDs, and usernames out
  of every log, evidence file, and PR.
- Firefox hides the feature, so a Firefox run proving nothing here is correct.
- Logging out of the second account anywhere ends the linked session. The next
  linked viewer query then shows the ended state, which is the feature working.
