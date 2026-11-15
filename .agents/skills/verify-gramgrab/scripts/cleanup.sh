#!/usr/bin/env bash
# Tear down the instance launch.sh started. Kills only the recorded PID and
# removes only the run state under .local/verify/.
#
# The profile at .local/verify-profile/ is left alone so its Instagram and
# WhatsApp Web sign-ins survive. Pass --reset-profile to delete it too, which
# means signing in by hand again. Evidence under .local/verify-evidence/ is
# never touched. On Windows, from WSL or Git Bash, the profile and downloads
# live under %LOCALAPPDATA%; ../windows.md covers that path.
set -euo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
repo="$(cd "$here/../../../.." && pwd)"
reset_profile=no
[ "${1:-}" = "--reset-profile" ] && reset_profile=yes
windows=no
if [ -n "${WSL_DISTRO_NAME:-}" ] || [ "${OS:-}" = Windows_NT ]; then
  windows=yes
  # shellcheck source=windows.sh
  . "$here/windows.sh"
fi
session_dir="$repo/.local/verify"

# From Git Bash the recorded PID is a Windows PID, which only Windows-aware
# tools such as Node can probe.
browser_alive() {
  if [ "${win_from:-}" = native ]; then
    [ -n "$GRAMGRAB_VERIFY_PID" ] && node -e 'try { process.kill(Number(process.argv[1]), 0) } catch { process.exit(1) }' "$GRAMGRAB_VERIFY_PID"
  else
    kill -0 "$GRAMGRAB_VERIFY_PID" 2>/dev/null
  fi
}

if [ -f "$session_dir/session.env" ]; then
  # shellcheck disable=SC1091
  . "$session_dir/session.env"

  # Chromium batches cookie writes on a timer and only flushes them on a real
  # exit. SIGTERM does not do it, measurably, so ask the browser to close over
  # CDP first and keep signals as the fallback for a wedged process.
  if browser_alive; then
    node "$here/drive.mjs" close >/dev/null 2>&1 || true
    for _ in $(seq 1 60); do
      browser_alive || break
      sleep 0.25
    done
  fi

  # On WSL the recorded PID is the interop process, so a signal would not reach
  # Helium. Stop the Windows process that holds this profile instead.
  if [ "$windows" = yes ] && browser_alive; then
    echo "Browser did not close in 15s; stopping it. A very recent sign-in may be lost." >&2
    for windows_pid in $(win_profile_pids "$(win_path "$GRAMGRAB_VERIFY_PROFILE")"); do
      win taskkill.exe /PID "$windows_pid" /T /F >/dev/null 2>&1 || true
    done
  fi

  if [ "${win_from:-}" != native ] && browser_alive; then
    kill "$GRAMGRAB_VERIFY_PID" 2>/dev/null || true
    for _ in $(seq 1 120); do
      browser_alive || break
      sleep 0.25
    done
    if browser_alive; then
      echo "Browser did not exit in 30s; forcing it. A very recent sign-in may be lost." >&2
      kill -9 "$GRAMGRAB_VERIFY_PID" 2>/dev/null || true
    fi
  fi
  [ -n "${GRAMGRAB_VERIFY_RELAY_PID:-}" ] && kill "$GRAMGRAB_VERIFY_RELAY_PID" 2>/dev/null || true
  echo "Stopped session $GRAMGRAB_VERIFY_PID."
else
  echo "No session to stop."
fi

rm -rf "$session_dir"
default_profile="$repo/.local/verify-profile"
if [ "$windows" = yes ]; then
  win_unregister_host
  rm -rf "$win_dir/downloads"
  default_profile="$win_dir/profile"
fi

if [ "$reset_profile" = yes ]; then
  # Only ever the default profile. A GRAMGRAB_PROFILE path belongs to the
  # person who named it, so this never deletes one.
  rm -rf "$default_profile"
  if [ "$windows" = yes ] && [ -f "$win_seed/Local State" ]; then
    echo "Deleted $default_profile. The next launch copies it again from $win_seed."
  else
    echo "Deleted $default_profile. You will have to sign in again."
  fi
else
  echo "Kept $default_profile with its sign-ins."
fi

echo "Evidence kept in $repo/.local/verify-evidence/."
