// fallow-ignore-file unused-file
// fallow-ignore-file complexity
/* eslint-env browser */
// Paste this entire file into the DevTools console on https://www.instagram.com
// (logged in). Edit the constants below, then hit Enter.
// It will download one JSON per IG endpoint we depend on to your Downloads folder.
// Wrapped in a block so re-pasting in DevTools doesn't trip "redeclaration of const".
{
  const HIGHLIGHT_ID = '18209932282300409'; // from /stories/highlights/<ID>/
  const STORY_USERNAME = 'povofpriya_'; // someone with an ACTIVE story right now
  const AVATAR_USERNAME = 'p_ooja4.7'; // any username
  const TRAY_USERNAME = 'p_ooja4.7'; // user whose highlights tray to fetch
  const PROFILE_USERNAME = 'instagram'; // user for web_profile_info
  // Shortcodes for each branch of the ShortcodeMedia union — one per __typename.
  // Find one of each by browsing instagram.com: /p/<code>/ for image+sidecar, /reel/<code>/ for video.
  const POST_IMAGE_SHORTCODE = 'DTcTRAhD193CeTqoVzSE83w8-uk_kVg9JpIKGg0'; // single-image post → GraphImage / XDTGraphImage
  const POST_VIDEO_SHORTCODE = 'DTriwtBEsgUGtjY0-yVkrCWvMTE2cQqfDya3aE0'; // single-video reel → GraphVideo / XDTGraphVideo
  const POST_SIDECAR_SHORTCODE = 'DU3LlIqkgBxSA8STfocQ8RWKm82CIBpTpfb5kg0'; // carousel post → GraphSidecar / XDTGraphSidecar

  // ---------------------------------------------------------------------------

  (async () => {
    const APP_ID = '936619743392459';
    const REELS_QUERY_HASH = '45246d3fe16ccc6577e0bd297a5db1ab';
    const SHORTCODE_DOC_ID = '8845758582119845';

    // Arrays under these keys hold tagged-union variants (story items can be
    // video vs image, sidecar children can be video vs image, tray lists every
    // highlight). Truncating them would silently drop branches we need to test,
    // so they're kept in full. All other arrays are capped at 3 to keep fixtures
    // small — fine for size-variant lists like display_resources / video_resources
    // where every entry is the same shape.
    const KEEP_FULL = new Set(['items', 'edges', 'tray']);
    function trim(v, parentKey) {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) {
        const arr = KEEP_FULL.has(parentKey) ? v : v.slice(0, 3);
        return arr.map(item => trim(item, parentKey));
      }
      const o = {};
      for (const k of Object.keys(v)) o[k] = trim(v[k], k);
      return o;
    }

    function dl(name, obj) {
      const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    async function webProfileInfo(username) {
      const r = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        { credentials: 'include', headers: { 'X-IG-App-ID': APP_ID } }
      );
      return { status: r.status, json: await r.json() };
    }

    async function userIdFromUsername(username) {
      const { status, json } = await webProfileInfo(username);
      const id = json?.data?.user?.id;
      if (!id) throw new Error(`Could not resolve user id for ${username} (status ${status})`);
      return id;
    }

    async function graphqlFetch(params) {
      const qs = new URLSearchParams(params);
      const r = await fetch(`https://www.instagram.com/graphql/query/?${qs}`, {
        credentials: 'include',
        headers: { 'X-IG-App-ID': APP_ID },
      });
      return r.json();
    }

    async function reelsFetch(vars) {
      return graphqlFetch({ query_hash: REELS_QUERY_HASH, variables: JSON.stringify(vars) });
    }

    const steps = [
      {
        label: 'highlights.json (reels_media / GraphHighlightReel)',
        run: async () => {
          const j = await reelsFetch({
            highlight_reel_ids: [HIGHLIGHT_ID],
            reel_ids: [],
            location_ids: [],
            precomposed_overlay: false,
          });
          dl('highlights.json', { data: trim(j.data), errors: j.errors ?? null });
        },
      },
      {
        label: `story.json (reels_media / GraphReel) for @${STORY_USERNAME}`,
        run: async () => {
          const userId = await userIdFromUsername(STORY_USERNAME);
          const j = await reelsFetch({
            reel_ids: [userId],
            highlight_reel_ids: [],
            location_ids: [],
            precomposed_overlay: false,
          });
          const reels = j?.data?.reels_media;
          if (!reels || reels.length === 0) {
            console.warn(
              `  story user "${STORY_USERNAME}" has no active stories right now — pick another username`
            );
          }
          dl('story.json', { data: trim(j.data), errors: j.errors ?? null });
        },
      },
      {
        label: `avatar.json (users/{id}/info/) for @${AVATAR_USERNAME}`,
        run: async () => {
          const userId = await userIdFromUsername(AVATAR_USERNAME);
          const r = await fetch(`https://i.instagram.com/api/v1/users/${userId}/info/`, {
            credentials: 'include',
            headers: { 'X-IG-App-ID': APP_ID, Origin: 'https://www.instagram.com' },
          });
          console.log('  status:', r.status);
          dl('avatar.json', trim(await r.json()));
        },
      },
      {
        label: `highlights-tray.json (highlights/{id}/highlights_tray/) for @${TRAY_USERNAME}`,
        run: async () => {
          const userId = await userIdFromUsername(TRAY_USERNAME);
          const r = await fetch(
            `https://i.instagram.com/api/v1/highlights/${encodeURIComponent(userId)}/highlights_tray/`,
            {
              credentials: 'include',
              headers: { 'X-IG-App-ID': APP_ID, Origin: 'https://www.instagram.com' },
            }
          );
          console.log('  status:', r.status);
          const j = await r.json();
          if (!j?.tray || j.tray.length === 0) {
            console.warn(
              `  @${TRAY_USERNAME} has no highlights tray — pick a user with visible highlights`
            );
          }
          dl('highlights-tray.json', trim(j));
        },
      },
      {
        label: `web-profile-info.json (web_profile_info) for @${PROFILE_USERNAME}`,
        run: async () => {
          const { status, json } = await webProfileInfo(PROFILE_USERNAME);
          console.log('  status:', status);
          dl('web-profile-info.json', trim(json));
        },
      },
      ...[
        ['shortcode-image.json', POST_IMAGE_SHORTCODE, 'image post'],
        ['shortcode-video.json', POST_VIDEO_SHORTCODE, 'video reel'],
        ['shortcode-sidecar.json', POST_SIDECAR_SHORTCODE, 'sidecar carousel'],
      ].map(([file, shortcode, kind]) => ({
        label: `${file} (xdt_shortcode_media, ${kind}) for /p/${shortcode}/`,
        run: async () => {
          const j = await graphqlFetch({
            doc_id: SHORTCODE_DOC_ID,
            variables: JSON.stringify({ shortcode }),
          });
          const node = j?.data?.xdt_shortcode_media ?? j?.data?.shortcode_media;
          if (!node) {
            console.warn(`  shortcode "${shortcode}" returned no media — pick a public ${kind}`);
          } else {
            console.log('  __typename:', node.__typename);
          }
          dl(file, { data: trim(j.data), errors: j.errors ?? null });
        },
      })),
    ];

    for (let i = 0; i < steps.length; i++) {
      const { label, run } = steps[i];
      console.log(`[${i + 1}/${steps.length}] ${label}`);
      try {
        await run();
        console.log('  → downloaded');
      } catch (e) {
        console.error('  failed:', e);
      }
    }

    console.log('done. check your Downloads folder.');
  })();
}
