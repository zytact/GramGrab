# Verifying on Windows

On Windows, `launch.sh`, `signin.sh`, `cleanup.sh` and `drive.mjs` drive Windows
Helium. That holds from two shells, and `scripts/windows.sh` holds what they
share:

- **Git Bash on Windows.** The build, the native host, the CLI and
  `doctor.mjs` all run on Windows. The host listens on a named pipe,
  `\\.\pipe\gramgrab-verify-<id>`, instead of a Unix socket.
- **WSL.** The browser runs on Windows, so it uses Windows memory and never
  opens a WSLg window. The build, the native host, its socket, the CLI and
  `doctor.mjs` stay in WSL.

The scripts are bash. In a PowerShell terminal, call Git Bash by its path,
because `bash` on `PATH` can be `C:\Windows\System32\bash.exe`, which is WSL:

```powershell
& "C:\Program Files\Git\bin\bash.exe" -lc '.agents/skills/verify-gramgrab/scripts/launch.sh'
```

`node` commands such as `doctor.mjs`, `drive.mjs` and the CLI run from
PowerShell too once the session variables are set. Sourcing `session.env` in
Git Bash is the simplest way to set them.

Never connect to, drive, or read the `DevToolsActivePort` of the person's own
Helium. Every run uses a separate profile, so it is a separate Helium process.
`launch.sh` refuses a `GRAMGRAB_PROFILE` that names the person's own Helium
profile.

Each checkout gets its own directory, `%LOCALAPPDATA%\gramgrab-verify\<id>`,
where `<id>` is the first 12 hex digits of the SHA-256 of the checkout's path:
the physical path on WSL, and the lowercased `C:/` path in Git Bash, which keeps
whatever case a path was typed in. Agents in different worktrees therefore
verify in parallel without sharing a profile, a browser, downloads or a socket.
The same checkout reached from WSL and from Git Bash gets two ids. The
`checkout` file in that directory names the worktree in Windows form.

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
paths on WSL and the `C:/` form in Git Bash. `--reset-profile` deletes only this
checkout's profile, never the seed.

A worktree deleted without its profile leaves its `<id>` directory behind. Read
its `checkout` file, and remove the directory once that path is gone.

From WSL the profile cannot live under `.local/`. Helium opened from
`\\wsl.localhost` fails with `LockFileEx: Incorrect function` and
`database is locked`, then exits. Git Bash keeps the same layout so both shells
share the seed.

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
`%GRAMGRAB_VERIFY_HOST%`, the launcher `launch.sh` writes to
`.local/verify/native-host` (WSL) or `.local/verify/native-host.cmd` (Git Bash).
When `GRAMGRAB_VERIFY_DISTRO` is set it runs the launcher through
`wsl.exe -d <distro> -e`. The launcher starts this checkout's
`apps/native-host/bin/gramgrab-native-host.mjs`, so each browser reaches its own
checkout's host and endpoint.

`launch.sh` sets those variables, and `GRAMGRAB_IPC_PATH`, on Helium's
environment. From WSL they travel through `WSLENV`. Plain names work there,
while the `/u` flag silently drops the variable. The key is per user, so the
person's own Helium sees it too, and their installed GramGrab connects to it.
That browser has no `GRAMGRAB_VERIFY_HOST`, and the batch file turns it away.

Every launch writes the same batch file, manifest and key, rewriting a file only
when its bytes differ. Cleanup removes the key only when no other checkout that
still exists has a `.local/verify/native-host` or `native-host.cmd` launcher,
since launch writes that launcher before the key.

Helium reads the `Chromium` key before `Google\Chrome`. While any session runs,
it therefore hides a real Windows install of the GramGrab host, which
`docs/cli-setup.md` registers under `Google\Chrome`.

## CDP

From Git Bash, `launch.sh` picks a free port and Helium listens on it, as on
Linux.

WSL in NAT mode cannot reach Windows `127.0.0.1`. From WSL, Helium picks its
own debugging port and prints it to `browser.log`. `launch.sh` then starts
`scripts/cdp-relay.mjs`, which forwards a local port through one `powershell.exe`
per connection, and records that local port as `GRAMGRAB_CDP_PORT`. Each
`drive.mjs` command takes about a second longer than on Linux.

## Processes

From Git Bash, `$!` names a launcher that exits once Helium starts.
`launch.sh` records the Windows PID of the Helium holding this profile as
`GRAMGRAB_VERIFY_PID` for `doctor.mjs`. Cleanup does not trust that PID. It
asks Windows which Helium holds the profile. From WSL the PID is the interop
process.

`session.env` records the shell that launched the session as
`GRAMGRAB_VERIFY_PLATFORM`, `wsl` or `native`. Its paths only make sense in that
shell, so cleanup run from the other one refuses and names it.

## Windows and focus

The browser runs headless by default on Windows, because a Helium window takes
focus from whatever the person is doing. Headless covers everything except human
checkpoints. For those, tell the person a window is about to open, then launch
with `GRAMGRAB_HEADLESS=0`.

## When something fails

- `Profile ... is in use by another Helium`: an earlier run in this checkout is
  still up. Run `cleanup.sh`, and if its browser was wedged, cleanup stops it
  with `taskkill`. That only matches browsers on this checkout's profile.
- `Helium is running` from `signin.sh`: the person's own Helium is open. Ask
  them to close it. Do not stop it yourself.
- No native host endpoint: check the registry key with
  `reg.exe query 'HKCU\Software\Chromium\NativeMessagingHosts\dev.zytact.gramgrab'`,
  from `/mnt/c` on WSL, and confirm the launcher exists:
  `.local/verify/native-host`, executable, on WSL, or
  `.local/verify/native-host.cmd` in Git Bash.
- A key left behind after every session ended means a checkout kept its
  launcher after its session died, for example across a Windows reboot. Run
  `cleanup.sh` in that checkout. Its `checkout` file under
  `gramgrab-verify\<id>` names it.
- `drive.mjs upload` converts its file argument with `wslpath -w` on WSL, so
  give it a WSL path as usual.
- `launch.sh` failing in `vp run build:chromium` with `Cannot find native
  binding` means `node_modules` lacks the win32 Vite+ binding. `vp install`
  alone did not restore it; `vp install --force` did.
