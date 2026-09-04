#!/usr/bin/env bash
# Tear down the instance launch.sh started. Kills only the recorded PID and
# removes only the run state under .local/verify/.
#
# The profile at .local/verify-profile/ is left alone so its Instagram and
# WhatsApp Web sign-ins survive. Pass --reset-profile to delete it too, which
# means signing in by hand again. Evidence under .local/verify-evidence/ is
# never touched.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
session_dir="$repo/.local/verify"
reset_profile=no
[ "${1:-}" = "--reset-profile" ] && reset_profile=yes

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
  echo "Stopped session $GRAMGRAB_VERIFY_PID."
else
  echo "No session to stop."
fi

rm -rf "$session_dir"

if [ "$reset_profile" = yes ]; then
  # Only ever the default profile. A GRAMGRAB_PROFILE path belongs to the
  # person who named it, so this never deletes one.
  rm -rf "$repo/.local/verify-profile"
  echo "Deleted .local/verify-profile/. You will have to sign in again."
else
  echo "Kept .local/verify-profile/ with its sign-ins."
fi

echo "Evidence kept in $repo/.local/verify-evidence/."
