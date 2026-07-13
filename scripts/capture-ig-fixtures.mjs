// fallow-ignore-file unused-file
// fallow-ignore-file complexity
/* eslint-env browser */
// Template for `vp run generate:ig-fixtures`. The generated local output is the
// file to paste into the DevTools console on https://www.instagram.com (logged in).
// It will download one JSON per IG endpoint we depend on to your Downloads folder.
// Wrapped in a block so re-pasting in DevTools doesn't trip "redeclaration of const".
{
  const CAPTURE_CONFIG = JSON.parse('__IG_FIXTURE_CAPTURE_CONFIG__');
  const {
    IG_HIGHLIGHT_ID: HIGHLIGHT_ID,
    IG_STORY_USERNAME: STORY_USERNAME,
    IG_AVATAR_USERNAME: AVATAR_USERNAME,
    IG_TRAY_USERNAME: TRAY_USERNAME,
    IG_PROFILE_USERNAME: PROFILE_USERNAME,
    IG_POST_IMAGE: POST_IMAGE,
    IG_POST_VIDEO: POST_VIDEO,
    IG_POST_SIDECAR: POST_SIDECAR,
  } = CAPTURE_CONFIG;

  // IG_HIGHLIGHT_ID is from /stories/highlights/<ID>/. IG_STORY_USERNAME must have an active Story.
  // IG_AVATAR_USERNAME can be any user, IG_TRAY_USERNAME needs visible Highlights, and IG_PROFILE_USERNAME
  // is used for web_profile_info. Posts may be public Instagram URLs or shortcodes.
  // Shortcodes for each branch of the ShortcodeMedia union — one per __typename.
  // Find one of each by browsing instagram.com: /p/<code>/ for image+sidecar, /reel/<code>/ for video.
  // ---------------------------------------------------------------------------

  void (async () => {
    const APP_ID = '936619743392459';
    const REELS_QUERY_HASH = '45246d3fe16ccc6577e0bd297a5db1ab';
    const SHORTCODE_DOC_IDS = ['8845758582119845', '10015901848480474'];

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

    function assertOkResponse(name, status, json, hasRequiredData) {
      if (status && (status < 200 || status >= 300)) {
        throw new Error(`${name} failed with HTTP ${status}`);
      }
      if (!hasRequiredData(json)) {
        const errors = json?.errors?.length ? ` errors: ${JSON.stringify(json.errors)}` : '';
        throw new Error(`${name} returned no required data.${errors}`);
      }
      if (json?.errors?.length) console.warn(`  ${name} partial errors:`, json.errors);
      return json;
    }

    async function readJsonResponse(r) {
      const text = await r.text();
      try {
        return { status: r.status, json: JSON.parse(text) };
      } catch {
        return { status: r.status, json: null, text: text.slice(0, 200) };
      }
    }

    function shortcodeFrom(input, kind) {
      const raw = String(input ?? '').trim();
      if (!raw) throw new Error(`Set a public ${kind} URL or shortcode`);
      const urlMatch = raw.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|tv)\/([^/?#]+)/i);
      const shortcode = urlMatch?.[1] ?? raw.replace(/^\/+|\/+$/g, '');
      if (!/^[A-Za-z0-9_-]+$/.test(shortcode)) {
        throw new Error(`Invalid ${kind} shortcode: "${raw}"`);
      }
      return shortcode;
    }

    function getLsdToken() {
      return (
        document.querySelector('input[name="lsd"]')?.value ??
        document.cookie.match(/(?:^|;\s*)lsd=([^;]+)/)?.[1] ??
        document.documentElement.innerHTML.match(/"LSD",\[\],{"token":"([^"]+)"/)?.[1] ??
        ''
      );
    }

    async function webProfileInfo(username) {
      const normalizedUsername = String(username).trim();
      const r = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(normalizedUsername)}`,
        { credentials: 'include', headers: { 'X-IG-App-ID': APP_ID } }
      );
      return readJsonResponse(r);
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
      return readJsonResponse(r);
    }

    async function apiGraphqlFetch(docId, vars) {
      const lsd = getLsdToken();
      const body = new URLSearchParams({
        doc_id: docId,
        variables: JSON.stringify(vars),
      });
      if (lsd) body.set('lsd', lsd);
      const r = await fetch('https://www.instagram.com/api/graphql/', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-IG-App-ID': APP_ID,
          'X-ASBD-ID': '129477',
          ...(lsd ? { 'X-FB-LSD': lsd } : {}),
        },
        body,
      });
      return readJsonResponse(r);
    }

    async function shortcodeFetch(shortcode) {
      const vars = { shortcode };
      const failures = [];
      for (const docId of SHORTCODE_DOC_IDS) {
        for (const fetcher of [
          () => graphqlFetch({ doc_id: docId, variables: JSON.stringify(vars) }),
          () => apiGraphqlFetch(docId, vars),
        ]) {
          try {
            const { status, json, text } = await fetcher();
            const node = jNode(json);
            if (status >= 200 && status < 300 && node) return json;
            failures.push({ docId, status, errors: json?.errors ?? null, text: text ?? null });
          } catch (e) {
            failures.push({ docId, error: String(e) });
          }
        }
      }
      throw new Error(`No shortcode media for "${shortcode}": ${JSON.stringify(failures)}`);
    }

    function jNode(j) {
      return (
        j?.data?.xdt_shortcode_media ??
        j?.data?.shortcode_media ??
        j?.data?.media ??
        j?.xdt_shortcode_media ??
        j?.shortcode_media ??
        j?.media
      );
    }

    async function reelsFetch(vars) {
      const { status, json } = await graphqlFetch({
        query_hash: REELS_QUERY_HASH,
        variables: JSON.stringify(vars),
      });
      return assertOkResponse(
        'reels_media',
        status,
        json,
        j => Array.isArray(j?.data?.reels_media) && j.data.reels_media.length > 0
      );
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
        ['shortcode-image.json', POST_IMAGE, 'image post', /Image/],
        ['shortcode-video.json', POST_VIDEO, 'video reel', /Video|ClipsShareVideo/],
        ['shortcode-sidecar.json', POST_SIDECAR, 'sidecar post', /Sidecar|Album/],
      ].map(([file, shortcode, kind, typenamePattern]) => ({
        label: `${file} (xdt_shortcode_media, ${kind}) for /p/${shortcode}/`,
        run: async () => {
          const code = shortcodeFrom(shortcode, kind);
          const j = await shortcodeFetch(code);
          const node = jNode(j);
          if (!node) throw new Error(`shortcode "${code}" returned no media`);
          if (!typenamePattern.test(node.__typename ?? '')) {
            throw new Error(
              `shortcode "${code}" returned ${node.__typename ?? 'unknown'}, expected ${kind}`
            );
          }
          if (
            kind === 'sidecar post' &&
            !node.edge_sidecar_to_children?.edges?.some(edge => edge.node?.is_video === true)
          ) {
            throw new Error(`shortcode "${code}" sidecar has no video child`);
          }
          console.log('  shortcode:', code);
          console.log('  __typename:', node.__typename);
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
