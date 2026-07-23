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
  const key = 'https://rl.kindlehub.internal/' + encodeURIComponent(ip) + '/' + Math.floor(Date.now() / (windowSec * 1000));
  const cache = caches.default;
  const hit = await cache.match(key);
  const n = hit ? parseInt(await hit.text(), 10) + 1 : 1;
  await cache.put(key, new Response(String(n), { headers: { 'Cache-Control': 'max-age=' + windowSec } }));
  return n > limit;
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
    if (req.method === 'OPTIONS') return json({ ok: true });
    const url = new URL(req.url);
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
