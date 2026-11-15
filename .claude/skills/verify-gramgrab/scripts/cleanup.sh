#!/usr/bin/env bash
# Tear down the instance launch.sh started. Stops only this session's browser
# and removes only the run state under .local/verify/.
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
platform=linux
if [ -n "${WSL_DISTRO_NAME:-}" ] || [ "${OS:-}" = Windows_NT ]; then
  # shellcheck source=windows.sh
  . "$here/windows.sh"
fi
session_dir="$repo/.local/verify"

# Git Bash has no handle on the Helium it started, so it asks Windows whether a
# Helium still holds this session's profile.
browser_alive() {
  if [ "$platform" = native ]; then
    [ -n "$(win_profile_pids "$(win_path "$GRAMGRAB_VERIFY_PROFILE")")" ]
  else
    kill -0 "$GRAMGRAB_VERIFY_PID" 2>/dev/null
  fi
}

# Waits up to $1 seconds for the browser to exit. A deadline, not a count,
# because each check from Git Bash starts PowerShell.
wait_for_exit() {
  local deadline=$((SECONDS + $1))
  while browser_alive && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.25; done
}

if [ -f "$session_dir/session.env" ]; then
  # shellcheck disable=SC1091
  . "$session_dir/session.env"
  # Paths and PIDs in the session only mean something to the shell that launched it.
  if [ "${GRAMGRAB_VERIFY_PLATFORM:-$platform}" != "$platform" ]; then
    echo "This session was launched from $GRAMGRAB_VERIFY_PLATFORM. Run cleanup.sh there." >&2
    exit 2
  fi

  # Chromium batches cookie writes on a timer and only flushes them on a real
  # exit. SIGTERM does not do it, measurably, so ask the browser to close over
  # CDP first and keep signals as the fallback for a wedged process.
  if browser_alive; then
    node "$here/drive.mjs" close >/dev/null 2>&1 || true
    wait_for_exit 15
  fi

  # A signal from WSL or Git Bash does not reach Windows Helium, so stop the
  # Windows process that holds this profile instead.
  if [ "$platform" != linux ] && browser_alive; then
    echo "Browser did not close in 15s; stopping it. A very recent sign-in may be lost." >&2
    for windows_pid in $(win_profile_pids "$(win_path "$GRAMGRAB_VERIFY_PROFILE")"); do
      win taskkill.exe /PID "$windows_pid" /T /F >/dev/null 2>&1 || true
    done
  fi

  if [ "$platform" != native ] && browser_alive; then
    kill "$GRAMGRAB_VERIFY_PID" 2>/dev/null || true
    wait_for_exit 30
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
if [ "$platform" != linux ]; then
  win_unregister_host
  rm -rf "$win_dir/downloads"
  default_profile="$win_dir/profile"
fi

if [ "$reset_profile" = yes ]; then
  # Only ever the default profile. A GRAMGRAB_PROFILE path belongs to the
  # person who named it, so this never deletes one.
  rm -rf "$default_profile"
  if [ "$platform" != linux ] && [ -f "$win_seed/Local State" ]; then
    echo "Deleted $default_profile. The next launch copies it again from $win_seed."
  else
    echo "Deleted $default_profile. You will have to sign in again."
  fi
else
  echo "Kept $default_profile with its sign-ins."
fi

echo "Evidence kept in $repo/.local/verify-evidence/."
