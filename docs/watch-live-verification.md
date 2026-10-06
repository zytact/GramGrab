# Watch live verification

The accepted rollout in [issue #205](https://github.com/zytact/GramGrab/issues/205)
uses Arnab's existing login and visible existing targets in the dedicated
verify-gramgrab Chromium profile. Account changes are outside this procedure.
Posts, Avatar uploads, renames, sign-outs and account switching must not be used
to manufacture events. New media and identity changes are verified only when
they occur naturally. No fixed soak, 25-Watch population or zero-429 gate applies.
Runtime request spacing, rolling capacity and shared backoff remain enforced.

## Procedure

1. Read the [Watches feature procedure](../.agents/skills/verify-gramgrab/features/watches.md).
   Fresh-launch the dedicated profile, run doctor, and package the CLI/native host.
   Drive the built options page and `artifacts/gramgrab.mjs`, retaining Beta in
   both the page and Watch help. Protocol version 2 makes this a breaking release.
2. Inspect an existing Watch before checking. Its creating login must verify.
   Record each registered kind's first check and whether it acted on existing
   media. A known identified empty response can baseline; a literal empty Story
   outer response cannot establish owner or absence and must fail closed.
3. Run the packaged smoke script with `--check`, then compare page and CLI needs
   and inbox counts. Keep one terminal stdout record and per-kind JSON progress
   on stderr. Failed, deferred, unknown or partial members require exit 1. Invalid grammar,
   including unavailable Stories in add, exits 2 before transport.
4. On a naturally collected entry, exercise Direct, Frame and Silent Export,
   explicit re-encode approval, rotation, frozen retry, per-child partial results
   and History. Verify that removal changes only inbox metadata. If no entry is
   available, retain a live gap and use the authoritative real-runner tests.
5. For startup, first fresh-launch the current build successfully. Close with
   cleanup, then use `launch.sh --restart` with the same profile. This preserves
   the unchanged build's service worker registration. Confirm one `watch-pump`
   alarm. In the dedicated profile only, temporarily make the existing login's
   next-round deadline overdue and remove its alarm before restart. Preserve the
   original deadline in memory, check that kind timestamps stay unchanged for
   two minutes, and observe the queued catch-up after the hold. Restore the
   original deadline while preserving new outcomes. Do not alter the ledger to
   bypass spacing, capacity or backoff.
6. Interrupt a worker during a feasible check or action, then reconnect the
   packaged CLI and inspect the durable checkpoint. Confirm accepted work is
   preserved and uncertainty requires an explicit decision. Save As acceptance
   needs an actual native dialog and naturally eligible media. Synthetic browser
   adapters own outcome-write failure and uncertainty where no live event exists.
7. Run `vp check`, `vp test run`, `vp run fallow`, `vp run build`,
   `vp run package:tools` and `vp run verify:whatsapp-packages`. Consult
   [boundary coverage](watch-boundary-coverage.md) for every extension-owned
   boundary and all 14 required Watch failure codes, plus notification failures.

Watch result files under `.local/verify-evidence/` hold only pass/fail values and
closed failure codes. Keep raw requests, CLI responses, store dumps, account/media
identifiers, names, captions, tokens and signed URLs in neither evidence nor PR
attachments. Store PR screenshots separately in `.local/pr-media/` and redact the verified login and any private preview target. Public official
`instagram` may appear in PR screenshots. The smoke script processes responses
in memory and projects them onto the permitted result fields.

After a Watch request protocol refresh, rerun affected feasible rows and update
this matrix. An unrun row does not disable a kind. A live kind row that actually
failed makes that kind unavailable in page and CLI add. Existing Watch state and
its fail-closed checks remain inspectable. Beta stays until Arnab removes it.

## Observed matrix, October 4-5, 2026

The run used the built Chromium extension, packaged version-2 CLI and the
existing login. The only stored Watch target was Instagram's public official account. The add
form preview used the existing visible login without creating another Watch.
Local result files contain booleans and codes; screenshots attached to the PRs
redact the verified login. No account mutation or automatic download was used.

| Row                                     | Observed result                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native bridge                           | Socket mode 0600, compatible protocol 2, built extension enabled                                                                                                   |
| Posts baseline and subsequent checks    | Passed, zero new media/action outcomes                                                                                                                             |
| Instants baseline and subsequent checks | Passed with no discovered Instant; a naturally new Instant remains unverified                                                                                      |
| Avatar baseline and subsequent checks   | Passed with no identity change; change/default transitions remain unverified                                                                                       |
| Stories baseline/check                  | Failed closed with `IG_RESPONSE_SHAPE_UNKNOWN` on a literal empty outer response without owner evidence. Unavailable in page and CLI add.                          |
| Packaged CLI check                      | Four per-kind progress records, one terminal result, exit 1 for failed Stories; other registered kinds passed                                                      |
| CLI list/needs/inbox and built page     | Counts match; check-problem recovery refused; unknown export/remove independently return exit 1                                                                    |
| Final packaged smoke/check              | Passed page/CLI contracts and exit 1 for a capacity-deferred check. This run acquired no kinds; the four-kind result above came from the earlier full check.       |
| Browser restart/alarm/startup           | Alarm recreated and no kind timestamps changed during the two-minute hold. Catch-up remained queued behind the rolling request cap; completion remains unverified. |
| Worker stop and page wake               | The page woke the worker, the CLI bridge recovered, the checkpoint survived and the startup deadline stayed unchanged. No live action was in flight.               |
| Actual inbox Export/action recovery     | No naturally collected media available. All modes, frozen retries, partial results and recovery have real-handler/runner synthetic coverage.                       |

## Accepted live gaps

| Unobserved fact                                                                                                  | Authoritative synthetic behavior                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Naturally new Posts/Reels/Sidecars/Stories/Instants and notification/download/collection                         | Baselines, cutoffs, independent actions, exact identities and per-child acceptance                                                                        |
| Avatar change, default Avatar, rename/reassignment                                                               | Stable account ID, verified rename, opaque picture identity and invalid/default refusal                                                                   |
| Literal empty Stories upstream meaning, real zero-Post/unavailable-Post variants, ordering beyond stopping point | Strict decoding and fail-closed absence/identity/order classification                                                                                     |
| Instant lifetime and feed completeness                                                                           | Strict ordered-feed decoding, owner matching and supported-feed absence                                                                                   |
| Actual transformed Watch Export and native Save As acceptance/uncertainty                                        | Real runner, frozen plans, browser acceptance adapter, reconciliation and explicit uncertainty                                                            |
| Active-worker action interruption without eligible natural media                                                 | Persistence-before-effects and real-dispatcher worker restart tests; no duplicate accepted sibling delivery                                               |
| Catch-up completion after the observed browser restart, held by rolling request capacity                         | Session startup hold, capacity admission, durable queued work and round resumption                                                                        |
| Owner switch/sign-out                                                                                            | Verified-login-only visibility and re-verification before delivery; stored count only on failed auth                                                      |
| Actual extension-manager reload                                                                                  | Fresh built worker loading is observed through a dedicated browser restart. `runtime.reload()` can disable an unpacked extension, so the skill avoids it. |
| Firefox alarm persistence, data-URL icon acceptance and actual notification rendering                            | Promise-based browser adapter, startup alarm recreation, notifications without buttons and packaged-icon fallback                                         |

No upstream coverage claim follows from a synthetic fixture or simulated browser.
