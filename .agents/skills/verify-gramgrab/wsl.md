# Verifying from WSL

On WSL, `launch.sh`, `signin.sh`, `cleanup.sh` and `drive.mjs` drive Helium on
Windows, not a browser inside WSL. The browser then uses Windows memory instead
of the WSL VM's, and it never opens a WSLg window. The build, the native host,
its socket, the CLI and `doctor.mjs` all stay in WSL and work as written in
SKILL.md. `scripts/wsl.sh` holds the Windows-specific parts.

Never connect to, drive, or read the `DevToolsActivePort` of the person's own
Helium. Every run uses a separate profile, so it is a separate Helium process.

Each checkout gets its own directory, `%LOCALAPPDATA%\gramgrab-verify\<id>`,
where `<id>` is the first 12 hex digits of the SHA-256 of the checkout's
physical path. Agents in different worktrees therefore verify in parallel
without sharing a profile, a browser, downloads or a socket. The `checkout` file
in that directory names the worktree it belongs to.

## Where things live

| What | Where |
| --- | --- |
| Browser | `%LOCALAPPDATA%\imput\Helium\Application\chrome.exe`, or `GRAMGRAB_BROWSER` |
| Profile | `gramgrab-verify\<id>\profile`, kept across runs |
| Extension | `gramgrab-verify\<id>\ext`, copied from `extension/chromium` on every launch |
| Downloads | `gramgrab-verify\<id>\downloads`, removed by cleanup |
| Sign-in seed | `gramgrab-verify\seed`, shared, written only by `signin.sh` |
| Native host | `gramgrab-verify\host`, shared and identical for every checkout, plus one registry key |

All of these sit under `%LOCALAPPDATA%`. `GRAMGRAB_VERIFY_PROFILE` and
`GRAMGRAB_VERIFY_DOWNLOADS` in `session.env` hold the `/mnt/c` form of those
paths. `--reset-profile` deletes only this checkout's profile, never the seed.

A worktree deleted without its profile leaves its `<id>` directory behind. Read
its `checkout` file, and remove the directory once that path is gone.

The profile cannot live under `.local/`. Helium opened from `\\wsl.localhost`
fails with `LockFileEx: Incorrect function` and `database is locked`, then exits.

## Sign-in is a copy

`signin.sh` copies the Instagram and WhatsApp Web sessions from the person's
own Helium (`Default` profile) into the shared seed, then from the seed into
this checkout's profile. It never opens a window to sign in. It copies
`Local State`, `Preferences`, `Secure Preferences`, `Network` (cookies),
`Local Storage`, `Session Storage`, and the Instagram and WhatsApp IndexedDB
folders. That comes to about 100 MB of the profile's several gigabytes.

Helium locks its cookie file while it runs, and no flag lifts that lock, so the
copy needs every Helium window closed. When `launch.sh` reports no profile, or a
run fails at Instagram authentication, ask the person to close Helium. Closing
it is the only step they do. Once they confirm, run `signin.sh` yourself, and
tell them they can reopen Helium as soon as it prints `Helium can be reopened
now`. The copy lasts until Instagram expires that session.

`launch.sh` in a checkout with no profile copies the seed into it, so only the
first checkout on a machine asks the person to close Helium. No browser ever
opens the seed, so it stays a clean snapshot. When Instagram expires the
session, `signin.sh` refreshes the seed and the current checkout. Other
checkouts keep their old copy until they run `signin.sh` or
`cleanup.sh --reset-profile` and launch again.

Verification browsers do not count as the person's Helium. `signin.sh` ignores
any Helium whose command line names a path under `gramgrab-verify`, so another
checkout's running session does not block a sign-in.

The copy includes the person's own WhatsApp Web link, which
`docs/whatsapp-live-verification.md` allows. Live capture is still a human
checkpoint as described in `features/whatsapp-status.md`.

## Native messaging

On Windows, Helium finds native hosts only through the registry, never in the
profile. `launch.sh` sets
`HKCU\Software\Chromium\NativeMessagingHosts\dev.zytact.gramgrab` to a manifest
whose host is `gramgrab.bat`. That batch file names no checkout. It runs
`wsl.exe -d <distro> -e "%GRAMGRAB_IPC_PATH%.host"`, and
`launch.sh` writes that `.host` launcher next to the session's socket in
`.local/verify/`. The launcher starts this checkout's
`apps/native-host/bin/gramgrab-native-host.mjs`, so each browser reaches its
own checkout's host and socket, all in WSL.

`launch.sh` passes the socket path through `WSLENV`. Plain
`WSLENV=GRAMGRAB_IPC_PATH` works here, while the `/u` flag silently drops the
variable. The key is per user, so the person's own Helium sees it too, and their
installed GramGrab connects to it. That browser has no `GRAMGRAB_IPC_PATH`, and
the batch file turns it away.

Every launch writes the same batch file, manifest and key, rewriting a file only
when its bytes differ. Cleanup removes the key only when no other checkout that
still exists has a `.local/verify/gramgrab.sock.host` launcher, since launch
writes that launcher before the key.

Helium reads the `Chromium` key before `Google\Chrome`. While any session runs,
it therefore hides a real Windows install of the GramGrab host, which
`docs/cli-setup.md` registers under `Google\Chrome`.

## CDP

WSL in NAT mode cannot reach Windows `127.0.0.1`. Helium picks its own debugging
port and prints it to `browser.log`. `launch.sh` then starts
`scripts/cdp-relay.mjs`, which forwards a local port through one `powershell.exe`
per connection, and records that local port as `GRAMGRAB_CDP_PORT`. Each
`drive.mjs` command takes about a second longer than on Linux.

## Windows and focus

The browser runs headless by default on WSL, because a Helium window takes focus
from whatever the person is doing. Headless covers everything except human
checkpoints. For those, tell the person a window is about to open, then launch
with `GRAMGRAB_HEADLESS=0`.

## When something fails

- `Profile ... is in use by another Helium`: an earlier run in this checkout is
  still up. Run `cleanup.sh`, and if its browser was wedged, cleanup stops it
  with `taskkill`. That only matches browsers on this checkout's profile.
- `Helium is running` from `signin.sh`: the person's own Helium is open. Ask
  them to close it. Do not stop it yourself.
- No native host socket: check the registry key with
  `reg.exe query 'HKCU\Software\Chromium\NativeMessagingHosts\dev.zytact.gramgrab'`
  from `/mnt/c`, and confirm `.local/verify/gramgrab.sock.host` exists and is
  executable.
- A key left behind after every session ended means a checkout kept its
  `.local/verify/gramgrab.sock.host` after its session died, for example across
  a Windows reboot.
  Run `cleanup.sh` in that checkout. Its `checkout` file under
  `gramgrab-verify\<id>` names it.
- `drive.mjs upload` converts its file argument with `wslpath -w`, so give it a
  WSL path as usual.
