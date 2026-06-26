/* ─────────────────────────────────────────────────────────────────────────
   state-worker.js — Cloudflare Worker: free-egress state storage for KindleHub
   ─────────────────────────────────────────────────────────────────────────

   WHY THIS EXISTS
   Supabase's free plan caps EGRESS (data downloaded) at 5 GB/month. KindleHub's
   single biggest egress source is every device downloading its encrypted state
   blob on sync. Cloudflare R2 has ZERO egress fees, so moving the state blob here
   removes that cost entirely — permanently, at any scale. Chat / mail / scores
   stay on Supabase (they're small and capped).

   COST: free. R2 free tier = 10 GB storage, 1,000,000 writes/mo, 10,000,000
   reads/mo, and $0 egress forever. For dozens–hundreds of users that's miles
   inside the free allowance.

   ── ONE-TIME SETUP (~5 min, all free) ──────────────────────────────────────
   1. Cloudflare dashboard → R2 → "Create bucket" → name it:  kindlehub-state
   2. Workers & Pages → "Create" → "Create Worker" → name it (e.g. kindlehub-state)
      → "Deploy", then "Edit code", paste THIS WHOLE FILE, and Deploy again.
   3. That Worker → Settings → "Variables and Secrets" → "R2 Bucket Bindings" →
      "Add binding":
            Variable name:  STATE_BUCKET
            R2 bucket:      kindlehub-state
   4. (Optional, recommended) Settings → Variables → add a plaintext variable:
            ALLOW_ORIGIN = https://kindlehub.pro
      (Defaults to "*", which is safe — blobs are end-to-end encrypted and the
       object key IS the user's secret password-hash, so "*" leaks nothing.)
   5. Copy the Worker URL, e.g.  https://kindlehub-state.YOURNAME.workers.dev
   6. In KindleHub: Admin → Local Insights → "State gateway (Cloudflare R2)" →
      paste the URL → Save. Sync immediately moves to R2. Leave it BLANK to keep
      using Supabase exactly as before (the app falls back automatically).

   SECURITY MODEL (identical to the Supabase one it replaces)
   • Objects are keyed by the user's auth hash = SHA-256(username + password) —
     a 64-hex secret only the account owner can produce. That hash gates access,
     same as the Supabase row key.
   • The blob is AES-GCM encrypted on the device BEFORE it ever leaves, so this
     Worker only ever stores/serves opaque ciphertext. It cannot read user data.

   HTTP API (the KindleHub client speaks this)
     GET  /state?hash=<64hex>&meta=1   → { updated_at }                (cheap probe)
     GET  /state?hash=<64hex>          → { state, updated_at }         (full blob)
     PUT  /state   body { hash, email, state }  → { updated_at }       (store)
   ───────────────────────────────────────────────────────────────────────── */

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_STATE = 16 * 1000 * 1000; // 16 MB ceiling, matches the Supabase CHECK

function cors(env) {
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOW_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors(env)),
  });
}

export default {
  async fetch(request, env) {
    const headers = cors(env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const bucket = env && env.STATE_BUCKET;
    if (!bucket) return json({ error: 'STATE_BUCKET R2 binding is missing — see setup step 3.' }, 500, env);

    const url = new URL(request.url);
    // Health check / friendly root
    if (url.pathname === '/' ) return json({ ok: true, service: 'kindlehub-state' }, 200, env);

    try {
      if (request.method === 'GET') {
        const hash = (url.searchParams.get('hash') || '').toLowerCase();
        if (!HEX64.test(hash)) return json({ error: 'bad hash' }, 400, env);
        const key = 'state/' + hash;

        if (url.searchParams.get('meta')) {
          // HEAD-only: returns metadata, NOT the body — the cheap "did it change?" probe.
          const head = await bucket.head(key);
          if (!head) return json({ updated_at: null }, 200, env);
          const ua = (head.customMetadata && head.customMetadata.updated_at) || (head.uploaded && head.uploaded.toISOString()) || '';
          return json({ updated_at: ua }, 200, env);
        }

        const obj = await bucket.get(key);
        if (!obj) return json({ state: null, updated_at: null }, 200, env);
        const state = await obj.text();
        const ua = (obj.customMetadata && obj.customMetadata.updated_at) || (obj.uploaded && obj.uploaded.toISOString()) || '';
        return json({ state, updated_at: ua }, 200, env);
      }

      if (request.method === 'PUT') {
        let body;
        try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400, env); }
        const hash = String(body.hash || '').toLowerCase();
        if (!HEX64.test(hash)) return json({ error: 'bad hash' }, 400, env);
        const state = typeof body.state === 'string' ? body.state : '';
        if (state.length > MAX_STATE) return json({ error: 'state too large' }, 413, env);
        const updated_at = new Date().toISOString();
        await bucket.put('state/' + hash, state, {
          httpMetadata: { contentType: 'text/plain' },
          customMetadata: { updated_at, email: String(body.email || '').slice(0, 200) },
        });
        return json({ updated_at }, 200, env);
      }

      return json({ error: 'method not allowed' }, 405, env);
    } catch (e) {
      return json({ error: String((e && e.message) || e).slice(0, 200) }, 500, env);
    }
  },
};
