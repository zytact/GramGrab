#!/usr/bin/env bash
# Tear down the instance launch.sh started. Kills only the recorded PID and
# removes only the run state under .local/verify/.
#
# The profile at .local/verify-profile/ is left alone so its Instagram and
# WhatsApp Web sign-ins survive. Pass --reset-profile to delete it too, which
# means signing in by hand again. Evidence under .local/verify-evidence/ is
# never touched. On WSL the profile and downloads live on the Windows side;
# ../wsl.md covers that path.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
session_dir="$repo/.local/verify"
reset_profile=no
[ "${1:-}" = "--reset-profile" ] && reset_profile=yes
wsl=no
if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  wsl=yes
  # shellcheck source=wsl.sh
  . "$(dirname "${BASH_SOURCE[0]}")/wsl.sh"
fi

if [ -f "$session_dir/session.env" ]; then
  # shellcheck disable=SC1091
  . "$session_dir/session.env"

  # Chromium batches cookie writes on a timer and only flushes them on a real
  # exit. SIGTERM does not do it, measurably, so ask the browser to close over
  # CDP first and keep signals as the fallback for a wedged process.
  if kill -0 "$GRAMGRAB_VERIFY_PID" 2>/dev/null; then
    node "$(dirname "${BASH_SOURCE[0]}")/drive.mjs" close >/dev/null 2>&1 || true
    for _ in $(seq 1 60); do
      kill -0 "$GRAMGRAB_VERIFY_PID" 2>/dev/null || break
      sleep 0.25
    done
  fi

  # The recorded PID on WSL is the interop process, so a signal would not reach
  # Helium. Stop the Windows process that holds this profile instead.
  if [ "$wsl" = yes ] && kill -0 "$GRAMGRAB_VERIFY_PID" 2>/dev/null; then
    echo "Browser did not close in 15s; stopping it. A very recent sign-in may be lost." >&2
    for windows_pid in $(wsl_profile_pids "$(wslpath -w "$GRAMGRAB_VERIFY_PROFILE")"); do
      win taskkill.exe /PID "$windows_pid" /T /F >/dev/null 2>&1 || true
    done
  fi

  if kill -0 "$GRAMGRAB_VERIFY_PID" 2>/dev/null; then
    kill "$GRAMGRAB_VERIFY_PID" 2>/dev/null || true
    for _ in $(seq 1 120); do
      kill -0 "$GRAMGRAB_VERIFY_PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$GRAMGRAB_VERIFY_PID" 2>/dev/null; then
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
if [ "$wsl" = yes ]; then
  wsl_unregister_host
  rm -rf "$wsl_dir/downloads"
  default_profile="$wsl_dir/profile"
fi

if [ "$reset_profile" = yes ]; then
  # Only ever the default profile. A GRAMGRAB_PROFILE path belongs to the
  # person who named it, so this never deletes one.
  rm -rf "$default_profile"
  if [ "$wsl" = yes ] && [ -f "$wsl_seed/Local State" ]; then
    echo "Deleted $default_profile. The next launch copies it again from $wsl_seed."
  else
    echo "Deleted $default_profile. You will have to sign in again."
  fi
else
  echo "Kept $default_profile with its sign-ins."
fi

echo "Evidence kept in $repo/.local/verify-evidence/."
