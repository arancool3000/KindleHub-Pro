/* ═══════════════════════════════════════════════════════════════════════════
   KindleHub Mail Gateway — Cloudflare Worker
   Makes username@kindlehub.pro a REAL email address: receives internet email
   into the KindleHub inbox, and sends outbound email from the Mail tab.

   ── ONE-TIME SETUP (≈10 minutes, all in dashboards) ───────────────────────
   1. INBOUND (receiving):
      Cloudflare dashboard → kindlehub.pro → Email → Email Routing → enable.
      Cloudflare adds the MX + SPF DNS records for you automatically.
      Then: Routing rules → Catch-all → action "Send to Worker" → this worker.

   2. OUTBOUND (sending) — uses Resend (resend.com, free tier 100 mails/day):
      a. Sign up at resend.com → Domains → add kindlehub.pro → add the DKIM
         DNS records it shows you (in Cloudflare DNS) → wait for "Verified".
      b. Resend → API Keys → create one.

   3. DEPLOY THIS WORKER:
      Cloudflare dashboard → Workers & Pages → Create Worker → paste this file.
      Settings → Variables → add:
        RESEND_API_KEY        from step 2b
        API_GATEWAY           your Cloudflare D1 api-worker URL, so mail lives in
                              the SAME database as the rest of KindleHub ($0
                              egress). e.g. https://kindlehub-api.YOURNAME.workers.dev
      (Optional) DAILY_SEND_CAP  default "80" — global outbound/day safety cap.

   4. CONNECT THE APP:
      Workers → your worker → copy its URL (https://….workers.dev), then on
      any device as admin run in the browser console (or ask Claude to add a
      Settings field):  localStorage.setItem('kh_mail_gateway','https://YOUR-WORKER-URL')
      The app's Mail tab detects it and external sending switches on.

   ── DESIGN NOTES ──────────────────────────────────────────────────────────
   • Inbound mail is stored PLAINTEXT in kh_mail (the app's _msgDecrypt passes
     plaintext through, so it renders with zero app changes). Internal
     KindleHub-to-KindleHub mail stays AES-encrypted as before.
   • Unknown recipients are rejected (Email Routing shows "bounced") unless
     they exist in kh_users — so spam to random@kindlehub.pro never lands.
   • Outbound: From is always <username>@kindlehub.pro where username must
     exist in kh_users; Reply-To works automatically when they answer.
   • The /send endpoint is as public as the rest of the KindleHub backend
     (the app has no server auth). Mitigations: per-IP rate limit (10/hour),
     a global daily cap, and Resend's own quota. Good enough for a community
     of trusted users; tighten later by requiring a token if abused.
   • MIME parsing below is intentionally small: text/plain (incl. base64 /
     quoted-printable) and the text part of simple multiparts. HTML-only
     mail falls back to a tag-stripped version. Attachments are dropped —
     a Kindle can't do much with them anyway.
═══════════════════════════════════════════════════════════════════════════ */

const MAIL_DOMAIN = 'kindlehub.pro';

/* ── tiny helpers ─────────────────────────────────────────────────────── */
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json',
               'Access-Control-Allow-Origin': '*',
               'Access-Control-Allow-Headers': 'content-type',
               'Access-Control-Allow-Methods': 'POST,OPTIONS', ...extra },
  });

/* Backend base URL: the Cloudflare D1 gateway (API_GATEWAY), so mail lives in the
   SAME database as the rest of KindleHub ($0 egress). The D1 Worker speaks a
   PostgREST subset, so the paths below map straight onto it (it ignores the
   apikey/auth headers — open insert/select). */
const _base = env => String(env.API_GATEWAY || '').replace(/\/+$/, '');
function _bhdr(env, extra) {
  const h = { 'Content-Type': 'application/json', ...(extra || {}) };
  return h;
}
async function sb(env, path, init = {}) {
  const r = await fetch(_base(env) + '/rest/v1' + path, {
    ...init,
    headers: _bhdr(env, { Prefer: 'return=minimal', ...(init.headers || {}) }),
  });
  if (!r.ok && r.status !== 201 && r.status !== 204)
    throw new Error('backend ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r;
}

async function userExists(env, username) {
  const r = await fetch(
    _base(env) + '/rest/v1/kh_users?email=eq.' + encodeURIComponent(username) + '&select=email&limit=1',
    { headers: _bhdr(env) },
  );
  if (!r.ok) return false;
  return ((await r.json()) || []).length > 0;
}

/* Verify the caller actually OWNS `username`: look up the account by its auth
   hash (the 64-hex secret only that account holder can produce) and check the
   stored email — normalised the same way as from_user — matches. Prevents
   sending mail "as" another user. */
async function userOwns(env, secret, username) {
  if (!/^[0-9a-f]{64}$/.test(secret || '')) return false;
  const r = await fetch(
    _base(env) + '/rest/v1/kh_users?hash=eq.' + encodeURIComponent(secret) + '&select=email',
    { headers: _bhdr(env) },
  );
  if (!r.ok) return false;
  const rows = (await r.json()) || [];
  if (!rows.length) return false;
  const email = String(rows[0].email || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  return email === username;
}

const newId = () => 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const newSecret = () => [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');

/* ── password-reset helpers ───────────────────────────────────────────────── */
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s || '')));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/* Length-safe, non-early-exit compare (both operands are fixed-length 64-hex
   SHA-256 strings, so the length branch leaks nothing). */
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const RESET_TTL_MS = 10 * 60 * 1000;   // reset code lifetime (10 minutes)

/* kh_reset lives in the SAME D1 backend as mail, but — unlike kh_mail — it is NOT
   public. The api-worker gates ALL kh_reset access behind a dedicated reset
   service secret (a 6-digit code stored as SHA-256(u+':'+code) would be brute-
   forceable if code_hash were world-readable, and an open write would let anyone
   set a code they know). Set the SAME value in env.RESET_SECRET on BOTH this
   Worker and the api-worker. Sent as X-KH-Reset-Secret; NEVER exposed to the
   browser (these endpoints only relay ok/error to the client). */
function _rhdr(env, extra) {
  return { 'Content-Type': 'application/json',
           'X-KH-Reset-Secret': String(env.RESET_SECRET || ''), ...(extra || {}) };
}
async function resetRowGet(env, u) {
  try {
    const r = await fetch(_base(env) + '/rest/v1/kh_reset?u=eq.' + encodeURIComponent(u) + '&limit=1',
      { headers: _rhdr(env) });
    if (!r.ok) return null;
    const rows = (await r.json()) || [];
    return rows[0] || null;
  } catch { return null; }
}
/* Upsert (INSERT … ON CONFLICT(u) DO UPDATE) — used both to issue a fresh code
   and to persist an incremented attempts count. Returns true on success. */
async function resetRowUpsert(env, row) {
  try {
    const r = await fetch(_base(env) + '/rest/v1/kh_reset?on_conflict=u', {
      method: 'POST',
      headers: _rhdr(env, { Prefer: 'return=minimal' }),
      body: JSON.stringify(row),
    });
    return r.ok || r.status === 201 || r.status === 204;
  } catch { return false; }
}
async function resetRowDelete(env, u) {
  try {
    await fetch(_base(env) + '/rest/v1/kh_reset?u=eq.' + encodeURIComponent(u),
      { method: 'DELETE', headers: _rhdr(env) });
  } catch { /* best-effort single-use consumption / cleanup */ }
}

/* ── minimal MIME text extraction ─────────────────────────────────────── */
function decodeQP(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => {
    try { return String.fromCharCode(parseInt(h, 16)); } catch { return _; }
  });
}
function decodeB64(s) {
  try {
    const bin = atob(s.replace(/\s+/g, ''));
    return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  } catch { return s; }
}
function decodePart(headers, body) {
  const enc = /content-transfer-encoding:\s*([^\s;]+)/i.exec(headers)?.[1]?.toLowerCase() || '';
  if (enc === 'base64') return decodeB64(body);
  if (enc === 'quoted-printable') return decodeQP(body);
  return body;
}
function extractText(raw, depth) {
  depth = depth || 0;
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const topHeaders = headerEnd > 0 ? raw.slice(0, headerEnd) : '';
  const topBody = headerEnd > 0 ? raw.slice(headerEnd).replace(/^\r?\n\r?\n/, '') : raw;
  const ctype = /content-type:\s*([^;\r\n]+)/i.exec(topHeaders)?.[1]?.toLowerCase() || 'text/plain';
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(topHeaders)?.[1];

  if (ctype.startsWith('multipart/') && boundary && depth < 4) {
    /* SECURITY: split on the boundary as a LITERAL STRING (String.split), never a
       RegExp built from attacker-controlled input — a dynamically assembled regex
       is a ReDoS / injection risk. Also cap the part count and recursion depth so
       a boundary-spammed or deeply-nested message can't pin the worker's CPU. */
    const rawParts = topBody.split('--' + boundary);
    let plain = null, html = null, nested = null, seen = 0;
    for (let p of rawParts) {
      if (++seen > 60) break;
      p = p.replace(/^--/, '').replace(/^\r?\n/, '');   // strip closing marker + leading CRLF
      const he = p.search(/\r?\n\r?\n/);
      if (he < 0) continue;
      const ph = p.slice(0, he), pb = p.slice(he).replace(/^\r?\n\r?\n/, '');
      const pct = /content-type:\s*([^;\r\n]+)/i.exec(ph)?.[1]?.toLowerCase() || '';
      if (pct.startsWith('multipart/') && nested === null) nested = extractText(p, depth + 1);
      else if (pct.startsWith('text/plain') && plain === null) plain = decodePart(ph, pb);
      else if (pct.startsWith('text/html') && html === null) html = decodePart(ph, pb);
    }
    if (plain) return plain;
    if (nested) return nested;
    if (html) return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').trim();
    return '(no readable text)';
  }
  const text = decodePart(topHeaders, topBody);
  if (ctype.startsWith('text/html'))
    return text.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return text;
}
/* RFC 2047 encoded-word subjects: =?utf-8?B?...?= / =?utf-8?Q?...?= */
function decodeSubject(s) {
  return String(s || '').replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, t, data) =>
    t.toUpperCase() === 'B' ? decodeB64(data) : decodeQP(data.replace(/_/g, ' ')),
  ).trim();
}

/* ── per-IP rate limit (Cache API — no KV needed) ─────────────────────── */
async function rateLimited(req, limit, windowSec) {
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  return rateLimitedKey(ip, limit, windowSec);
}
/* Same rolling-window counter keyed by an arbitrary string (a username hash,
   'GLOBAL-DAY', …). Behaviour is identical to the IP variant. */
async function rateLimitedKey(keyPart, limit, windowSec) {
  const key = 'https://rl.kindlehub.internal/' + encodeURIComponent(keyPart) + '/' + Math.floor(Date.now() / (windowSec * 1000));
  const cache = caches.default;
  const hit = await cache.match(key);
  const n = hit ? parseInt(await hit.text(), 10) + 1 : 1;
  await cache.put(key, new Response(String(n), { headers: { 'Cache-Control': 'max-age=' + windowSec } }));
  return n > limit;
}

/* ── PASSWORD RESET: request a code ─────────────────────────────────────────
   POST /reset/request  { u:<username_hash>, to:<recovery_email> }
   → { ok:true }                              (code generated + emailed)
   → { ok:false, error:<msg> }                (validation / rate-limit / send fail)
   The 6-digit code is emailed to `to`; only its hash (SHA-256(u+':'+code)) is
   stored in kh_reset, with a 10-min expiry. Per-`u` pacing: at most 1/60s (from
   the stored row's `created`) and 5/hour (a rolling per-`u` cache counter, since
   a single row can't hold an hourly count). Counts against DAILY_SEND_CAP like
   every other outbound mail. We never reveal whether the account/email exists. */
async function resetRequest(req, env) {
  let b; try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const u = String(b.u || '').trim().toLowerCase();
  const to = String(b.to || '').trim().slice(0, 160);
  if (!/^[0-9a-f]{16,128}$/.test(u)) return json({ ok: false, error: 'invalid request' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return json({ ok: false, error: 'invalid email address' }, 400);

  const now = Date.now();
  /* 1 request / 60s per u — enforced from the existing row's `created`. */
  const existing = await resetRowGet(env, u);
  if (existing && Number(existing.created) && (now - Number(existing.created)) < 60000)
    return json({ ok: false, error: 'Please wait a minute before requesting another code.' }, 200);
  /* 5 / hour per u (rolling window). */
  if (await rateLimitedKey('reset-hr/' + u, 5, 3600))
    return json({ ok: false, error: 'Too many reset requests — please try again later.' }, 200);

  /* Count against the shared daily outbound cap BEFORE issuing (so a capped day
     doesn't leave an unsent code lying around). Same GLOBAL-DAY key as /send. */
  const cap = parseInt(env.DAILY_SEND_CAP || '80', 10);
  if (await rateLimited({ headers: { get: () => 'GLOBAL-DAY' } }, cap, 86400))
    return json({ ok: false, error: 'Daily email limit reached — try again tomorrow.' }, 200);

  /* random, zero-padded 6-digit code; store ONLY its salted hash */
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const code_hash = await sha256hex(u + ':' + code);
  const stored = await resetRowUpsert(env, { u, code_hash, expires: now + RESET_TTL_MS, attempts: 0, created: now });
  if (!stored) return json({ ok: false, error: 'Could not start a reset right now — please try again.' }, 502);

  const from = env.RESET_FROM || 'KindleHub <noreply@kindlehub.pro>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Your KindleHub reset code',
      text: 'Your KindleHub password-reset code is ' + code + '. It expires in 10 minutes. '
          + "If you didn't request this, ignore this email.",
    }),
  });
  if (!r.ok) {
    /* Roll back the stored code so a transient send failure doesn't lock the user
       out of retrying for 60s. */
    await resetRowDelete(env, u);
    return json({ ok: false, error: 'Could not send the reset email — please try again.' }, 502);
  }
  return json({ ok: true });
}

/* ── PASSWORD RESET: verify a code ──────────────────────────────────────────
   POST /reset/verify  { u:<username_hash>, code:"123456" }
   → { ok:true }                         (correct → row deleted, single-use)
   → { ok:false, error:<msg> }           (expired / too many attempts / incorrect)
   No token is returned — the client then proceeds to its existing recovery-code +
   new-password step. Comparison is done here against the stored hash. */
async function resetVerify(req, env) {
  let b; try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const u = String(b.u || '').trim().toLowerCase();
  const code = String(b.code || '').trim();
  if (!/^[0-9a-f]{16,128}$/.test(u)) return json({ ok: false, error: 'invalid request' }, 400);

  const row = await resetRowGet(env, u);
  const now = Date.now();
  if (!row || !Number(row.expires) || Number(row.expires) < now)
    return json({ ok: false, error: 'That code has expired — request a new one.' }, 200);
  if (Number(row.attempts || 0) >= 5) {
    await resetRowDelete(env, u);
    return json({ ok: false, error: 'Too many attempts — request a new code.' }, 200);
  }
  const got = await sha256hex(u + ':' + code);
  if (!timingSafeEqual(String(row.code_hash || ''), got)) {
    /* persist the incremented attempt count (re-upsert the row) */
    await resetRowUpsert(env, {
      u, code_hash: String(row.code_hash || ''), expires: Number(row.expires),
      attempts: Number(row.attempts || 0) + 1, created: Number(row.created) || now,
    });
    return json({ ok: false, error: 'Incorrect code.' }, 200);
  }
  /* correct → consume it (single-use) */
  await resetRowDelete(env, u);
  return json({ ok: true });
}

export default {
  /* ── INBOUND: Email Routing hands every message for *@kindlehub.pro here ── */
  async email(message, env, ctx) {
    const toUser = (message.to || '').split('@')[0].toLowerCase().trim().slice(0, 40);
    if (!toUser || !(await userExists(env, toUser))) {
      message.setReject('No such mailbox');
      return;
    }
    const rawBuf = await new Response(message.raw).arrayBuffer();
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(rawBuf).slice(0, 200000);
    const text = (extractText(raw) || '').trim().slice(0, 8000);
    const subject = decodeSubject(message.headers.get('subject') || '(no subject)').slice(0, 160);
    const fromAddr = (message.from || 'unknown@unknown').toLowerCase().slice(0, 120);
    await sb(env, '/kh_mail', {
      method: 'POST',
      body: JSON.stringify([{
        id: newId(),
        to_user: toUser,
        from_user: fromAddr,          /* full external address — app shows it as-is */
        from_id: '__external__',
        subject,                       /* plaintext: the app passes it through */
        body: text || '(empty message)',
        ts: new Date().toISOString(),
        reply_to: '',
        owner_secret: newSecret(),
      }]),
    });
  },

  /* ── OUTBOUND: the app POSTs {to, from_user, subject, body} to /send ── */
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return json({ ok: true });   // CORS preflight for every path
    const url = new URL(req.url);
    /* Email-based password-reset flow (see resetRequest / resetVerify above). */
    if (req.method === 'POST' && url.pathname === '/reset/request') return resetRequest(req, env);
    if (req.method === 'POST' && url.pathname === '/reset/verify')  return resetVerify(req, env);
    if (req.method !== 'POST' || url.pathname !== '/send')
      return json({ error: 'POST /send only' }, 404);

    if (await rateLimited(req, 10, 3600))
      return json({ error: 'Rate limit: 10 external mails per hour per device.' }, 429);

    let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    const fromUser = String(b.from_user || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
    const to = String(b.to || '').toLowerCase().trim().slice(0, 120);
    const subject = String(b.subject || '(no subject)').slice(0, 160);
    const body = String(b.body || '').slice(0, 8000);
    if (!fromUser || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return json({ error: 'bad addresses' }, 400);
    if (to.endsWith('@' + MAIL_DOMAIN)) return json({ error: 'internal mail does not use the gateway' }, 400);
    /* SECURITY: require proof the caller OWNS `fromUser` (its account auth hash
       in X-KH-Secret) — not merely that the username exists. Without this anyone
       could send DKIM-signed mail AS any KindleHub user. */
    const secret = req.headers.get('x-kh-secret') || '';
    if (!(await userOwns(env, secret, fromUser)))
      return json({ error: 'sender not verified — you can only send as your own account' }, 403);

    /* Global daily cap so a runaway (or hostile) client can't torch the shared
       Resend quota. Counted only AFTER auth succeeds, so an UNauthenticated flood
       (which 403s just above) can't exhaust the day's sends for everyone. */
    const cap = parseInt(env.DAILY_SEND_CAP || '80', 10);
    if (await rateLimited({ headers: { get: () => 'GLOBAL-DAY' } }, cap, 86400))
      return json({ error: 'Daily external-mail limit reached — try tomorrow.' }, 429);

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'KindleHub <' + fromUser + '@' + MAIL_DOMAIN + '>',
        to: [to],
        subject,
        text: body + '\n\n—\nSent from KindleHub Mail (' + fromUser + '@' + MAIL_DOMAIN + ')',
        reply_to: fromUser + '@' + MAIL_DOMAIN,
      }),
    });
    if (!r.ok) {
      const t = (await r.text()).slice(0, 300);
      return json({ error: 'Email API refused: ' + t }, 502);
    }
    return json({ ok: true });
  },
};
