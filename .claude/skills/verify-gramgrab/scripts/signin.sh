#!/usr/bin/env bash
# Open the verification profile with Instagram and WhatsApp Web loaded so a
# person can sign in once. The sign-ins persist in .local/verify-profile/ and
# every later launch.sh reuses them.
#
# Sign in, then run scripts/cleanup.sh. Do not pass --reset-profile afterwards.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
cd "$repo"

"$here/launch.sh" >/dev/null
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
