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
- `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net` — the only
  external scripts we load are html2canvas + jszip from jsdelivr; an injected
  `<script src="//evil">` is blocked. (`'unsafe-inline'` is required because the
  single-file app uses inline `<script>` blocks and inline `onclick` handlers
  throughout; nonces cannot cover inline event handlers.)
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
patch"** power feature (`applyLocalFixes`, `S.localFixes`). That runs code the
signed-in user asked the AI to generate to patch their own client, stored only
in their own end-to-end-encrypted state (AES key = SHA-256(username+password),
which never leaves the device). It is self-authored code on your own device,
not attacker-supplied input, and the admin panel can disable or wipe all
patches. It is not reachable by other users.

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

## Backend / Supabase exposure  — addressed by the D1 migration

All users are now routed to the Cloudflare D1 worker by default
(`KH_DEFAULT_API_GATEWAY`), which enforces per-request auth, hashes/gates
`kh_users` reads, requires exact-PK match for open-table writes, and never
serves `owner_secret` on reads. The legacy Supabase path (public anon key +
RLS) remains only as a fallback; decommission it by blanking/rotating the
Supabase creds once migration is confirmed.

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
