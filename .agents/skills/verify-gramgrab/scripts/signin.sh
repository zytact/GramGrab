#!/usr/bin/env bash
# Open the verification profile with Instagram and WhatsApp Web loaded so a
# person can sign in once. The sign-ins persist in .local/verify-profile/ and
# every later launch.sh reuses them.
#
# Sign in, then run scripts/cleanup.sh. Do not pass --reset-profile afterwards.
#
# On WSL this copies the sign-ins from the person's own Helium instead, which
# needs that Helium closed. ../wsl.md explains why.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
cd "$repo"

if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  # shellcheck source=wsl.sh
  . "$here/wsl.sh"
  if [ -f "$repo/.local/verify/session.env" ]; then
    echo "A verification session is running. Run scripts/cleanup.sh first." >&2
    exit 2
  fi
  # Helium locks its cookie file while it runs, so the copy needs it closed.
  if [ -n "$(wsl_helium_pids '')" ]; then
    echo "Helium is running. Ask the person to close every Helium window, then run this again." >&2
    exit 2
  fi
  source="$wsl_daily_profile"
  target="$wsl_root/profile"
  rm -rf "$target"
  mkdir -p "$target/Default/IndexedDB"
  cp "$source/Local State" "$target/"
  # Only what carries the Instagram and WhatsApp Web sessions. The rest of the
  # profile is gigabytes of cache and unrelated sites.
  (
    cd "$source/Default"
    cp Preferences "Secure Preferences" "$target/Default/"
    cp -r Network "Local Storage" "Session Storage" "$target/Default/"
    cp -r IndexedDB/https_web.whatsapp.com_0.indexeddb.* IndexedDB/https_www.instagram.com_0.indexeddb.* \
      "$target/Default/IndexedDB/" 2>/dev/null || true
  )
  echo "Copied the Helium sign-ins to $target. Helium can be reopened now."
  exit 0
fi

# Signing in is a human step, so it always needs a visible window.
GRAMGRAB_HEADLESS=0 "$here/launch.sh" >/dev/null
# shellcheck disable=SC1091
. "$repo/.local/verify/session.env"

node "$here/drive.mjs" open "https://www.instagram.com/accounts/login/" >/dev/null
node "$here/drive.mjs" open "https://web.whatsapp.com/" >/dev/null

cat <<EOF
Profile: $GRAMGRAB_VERIFY_PROFILE

Two tabs are open. Sign in to both:
  1. Instagram, so acquisition paths resolve.
  2. WhatsApp Web, by linking a device, so Visible Status capture has a viewer.

Use accounts you are willing to test with. WhatsApp verification has its own
rules in docs/whatsapp-privacy.md and docs/whatsapp-live-verification.md, which
call for dedicated QA accounts and purpose-made test cards.

When both are signed in, run:
  $here/cleanup.sh
EOF
