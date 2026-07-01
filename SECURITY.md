# KindleHub Pro — security notes & audit response

This document records how KindleHub handles the issues raised in the v8.1.0
audit, which claims are real and fixed, and which are by-design (so they don't
get "re-fixed" in a way that breaks the app).

## HTTP security headers  — FIXED

`index.html` now ships a `Content-Security-Policy` and `referrer` via `<meta>`
tags (work on any host), and `_headers` sets the directives a `<meta>` tag
cannot express (HSTS, `X-Frame-Options`, `X-Content-Type-Options`,
`Permissions-Policy`, `frame-ancestors`).

**Why the CSP is not `default-src 'self'`.** KindleHub is a legitimate
multi-API client — it calls weather, maps tiles, news RSS, image, translate,
finance and geocoding endpoints, and it runs user-built "AI apps" that fetch
arbitrary APIs (mostly via the allorigins CORS proxy). A `default-src 'self'`
policy would break essentially the entire app. The shipped CSP still adds real
protection:

- `object-src 'none'` — no Flash/plugin XSS vector.
- `base-uri 'self'` — blocks `<base>`-tag hijacking.
- `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net` —
  the only external scripts we load are html2canvas + jszip from jsdelivr; an
  injected `<script src="//evil">` is blocked. (`'unsafe-inline'` is required
  because the single-file app uses inline `<script>` blocks and inline `onclick`
  handlers throughout; nonces cannot cover inline event handlers. `'unsafe-eval'`
  is required because the in-app spreadsheet (Sheets) and calculator evaluate
  user-entered formulas via `Function()`, and the app-patch feature runs via
  `new Function()`; without it those core features break on CSP-enforcing
  browsers. This means script-src is not a full XSS boundary — it blocks
  external-origin script loads, not inline/eval — which is why the render paths
  are DOM-built/escaped, below.)
- `frame-ancestors 'none'` + `X-Frame-Options: DENY` — anti-clickjacking.
- `connect-src`/`img-src`/`frame-src` are intentionally permissive over `https:`
  so the many real API integrations and sandboxed AI apps keep working.

### If the host is NOT Cloudflare Pages / Netlify

`_headers` is only auto-applied by Pages/Netlify. For a plain static host
proxied through Cloudflare, add the same headers with a **Transform Rule**:

Cloudflare dashboard → your domain → **Rules → Transform Rules → Modify
Response Header → Create rule**. Match `Hostname equals kindlehub.pro`, then add
these "Set static" headers:

| Header | Value |
| --- | --- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `accelerometer=(), camera=(), geolocation=(self), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()` |
| `Content-Security-Policy` | *(same string as the `<meta>` in index.html)* |

After adding, **Purge Everything** in the Cloudflare cache. Verify with
`curl -sI https://kindlehub.pro | grep -i -E 'content-security|strict-transport|x-frame|x-content'`.

> HSTS `preload` is intentionally omitted — only add it once you're certain
> every subdomain is HTTPS-only, because preload is hard to reverse.

## AI App Builder code execution  — already sandboxed

The audit worried that generated apps run via `new Function`. They do **not** —
AI-built apps and AI previews run inside `<iframe sandbox="allow-scripts
allow-forms allow-popups allow-modals">` **without** `allow-same-origin`, so
they execute in an opaque origin and cannot read KindleHub's `localStorage`,
auth token, cookies or DOM. That was fixed previously and is unchanged.

The one place `new Function` *is* used is the optional **"local fixes / AI
patch"** power feature (`applyLocalFixes`, `S.localFixes`) — code the signed-in
user asked the AI to generate to patch their own client. It is **hardened** so
the AI can't be used to escalate:

- **Escalation deny-list** (`_khPatchDenyRE`): both the boot applier and the
  "Apply patch" button refuse any patch whose code references admin/auth/
  credential/backend/encryption internals (`_isAdminCached`, `_adminToken`,
  `ADMIN_HASHES`, `authToken`, `kh_offline_cred`, `kh_users`, `SUPABASE_*`,
  `service_role`, `_sbBase`/`_sbFetch`, `_encryptState`/`_msgEncrypt`, …). The
  generator prompt is told the same. A blocked patch is disabled + recorded.
  This also neutralises any *already-stored* malicious patch on next boot.
- **Device-local only**: `S.localFixes` is stripped from the cloud blob on
  upload (`_trimStateForCloud`) **and** discarded from any incoming cloud state
  on merge (`mergeCloudState`), so a tampered/legacy synced state can never
  inject a boot-time patch onto another device.
- Client-side admin (`window._isAdminCached`) is only a **UI flag** — every
  privileged action is re-verified server-side by the D1 worker against a token
  whose SHA-256 must be in `ADMIN_HASHES` (a value derived from the admin's own
  password). So even setting the flag or forging the token grants **no** real
  cross-user power on D1 (verified by adversarial audit). The deny-list is
  defence-in-depth, not the boundary.

Note: the CSP carries `'unsafe-eval'` (the Sheets/calculator formula engine
needs `Function()`), so it does not itself block `new Function`; the app-layer
guards above do.

## localStorage contents  — mostly by design

- The **Supabase anon key** is *designed* to be public (it only works together
  with Row-Level-Security / the D1 worker's per-request auth). No `service_role`
  key is ever shipped to the client — verified: `service_role` appears only in
  SQL comments, never in client code.
- The user's **auth token** (`SHA-256(username+password)`) is the AES key for
  their own encrypted state and lives only in their own browser's localStorage
  (origin-scoped). It is never sent in plaintext and never stored server-side in
  a reversible form. The realistic threat to it is XSS — which is why the render
  paths are DOM-built/escaped (below) and the CSP limits script injection.
- Chat/notes/sheets held locally are plaintext-at-rest in localStorage. This is
  origin-scoped device-local data; encrypting it at rest would still require the
  key in memory and adds no protection against the actual threat model (physical
  device access or XSS). Cross-device sync IS encrypted in transit and at rest
  in the cloud.

## Backend / Supabase exposure  — CRITICAL, being closed

**The real hole.** The legacy Supabase project shipped fully-open RLS
(`kh_users_read`/`update` = `using (true)`). Because `kh_users.hash` =
SHA-256(username+password) is BOTH the login secret AND the AES key for that
user's `state`, anyone holding the (public) anon key could `SELECT` every
account's hash+state (full data compromise + impersonation) and `UPDATE` any
row (takeover, or inject a boot-time `localFix`). Cloudflare D1 was never
affected — it enforces per-request auth server-side.

What changed in the client (this repo):

- **Hardcoded Supabase URL + anon key blanked** (`SUPABASE_URL=''`,
  `SUPABASE_ANON_KEY=''`) — the shipped bundle no longer carries usable Supabase
  creds. (They were already public in git history, so this is hygiene; the DB
  fix is server-side, below.)
- **`_sbBase()` never falls back to Supabase** — live REST/RPC/shared-AI traffic
  goes only to the D1 gateway, or nowhere. The deprecated `kh_api_gateway='off'`
  escape hatch (which used to force Supabase) now routes to D1.
- **Realtime WS** paths require a real `supabase.co` URL, so a blank default
  never attempts a Supabase socket.
- The one-time **migration** tool still works if the admin pastes a Supabase
  URL+key at runtime (`kh_sb_url_override`), but nothing sensitive ships.

What YOU must still do on the server (the client change alone does not un-leak
already-scraped data):

1. **Run `supabase-lockdown.sql` now** (Supabase → SQL Editor). It revokes all
   anon/authenticated access to every `kh_*` table and adds deny policies;
   `service_role` still works for a final migration. Live traffic is on D1 so
   this breaks nothing.
2. **`schema.sql` was hardened** so re-running it can't reopen the hole —
   `kh_users` read/update are now self-only (`hash = kh_request_secret()`).
3. **Finish migrating** (via the service key, which bypasses RLS) and then
   **delete the Supabase project**.
4. **⚠ Rotate credentials.** The `hash` is the SAME auth secret on D1, so any
   hash scraped while Supabase was open also unlocks that account on D1. Have
   users **change their password** (regenerates the hash + re-keys state). Check
   Supabase logs for large historical `kh_users` reads to gauge real exposure.

## Stored XSS on render  — already defended

User-generated content shown to other users is rendered safely:

- Chat message bodies go through `_renderMessageText`, which builds DOM nodes
  with `createElement` + `textContent` + `createTextNode` — **no `innerHTML`**.
- Author names and reply/pin previews are HTML-escaped (`< > & " '`).
- Link detection (`_linkifyEl`) only creates `<a>` elements for `https?://`
  URLs (no `javascript:` scheme is possible) and sets `rel="noopener
  noreferrer"`.
- Notes/sheets render via `textContent`.

A scan for `innerHTML = ... + <user-variable>` sinks found none unescaped.

## Recommended follow-ups (host-side, not code)

- Rate-limit the AI builder (the D1 worker already has per-IP + global budget
  guards; the shared-key proxy has a daily cap).
- Turn on Cloudflare **Bot Fight Mode** for distributed abuse.
- Subresource Integrity (SRI) on the jsdelivr `<script>` tags is a reasonable
  hardening if you pin exact versions (html2canvas, jszip@3.10.1).
