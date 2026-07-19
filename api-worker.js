/* ─────────────────────────────────────────────────────────────────────────
   api-worker.js — Cloudflare Worker + D1: zero-egress backend for KindleHub
   ─────────────────────────────────────────────────────────────────────────

   WHY THIS EXISTS
   Supabase's free plan meters EGRESS (downloads) at 5 GB/mo. This Worker + a
   D1 (SQLite) database replace the Supabase REST layer the app uses for chat,
   mail, scores, announcements, presence, feedback, errors, bans and visits.
   Cloudflare charges $0 egress, so the quota problem goes away permanently.
   (Per-user state blobs already live on R2 via state-worker.js.)

   It speaks the SAME PostgREST-subset the client already sends, so the app
   only has to point its REST base URL here — no query rewrites. The RLS
   policies, RPCs and storage-cap triggers from schema.sql are reimplemented
   here in code.

   ── ONE-TIME SETUP (all free, no card) ──────────────────────────────────────
   ★ You do NOT need to run schema-d1.sql by hand. On its first request this
     Worker AUTO-CREATES every table (see ensureSchema below). So the whole setup
     is: deploy the Worker + bind a D1 database + open the app once.

   A) DASHBOARD ONLY (no CLI — recommended):
   1. D1 → Create database, name it "kindlehub".
   2. Workers & Pages → Create application → Worker → name it "kindlehub-api" →
      Deploy the starter → Edit code → paste THIS whole file → Deploy.
   3. That Worker → Settings → Bindings → Add binding → D1 database:
        Variable name = DB     Database = kindlehub      → Deploy.
   4. Hit the Worker URL once in a browser (it returns {"ok":true}) — that first
      request creates all 13 tables. Verify in D1 → kindlehub → Tables.
      ⚠ Do NOT try to paste schema-d1.sql into the dashboard:
        • the D1 "Console" tab runs ONE statement per Execute (it's a single-line
          box with /tables, /clear … slash commands); and
        • the "Studio" (Explore Data) editor's Run only executes the statement at
          the cursor — that's the "Executed 1/1 → only kh_users created" you saw.
        The auto-create in step 4 does the entire job, so skip the SQL console.

   B) WITH WRANGLER (CLI):
   1. npm i -g wrangler   (then `wrangler login`)
   2. wrangler d1 create kindlehub      → copy the printed database_id
   3. wrangler.toml next to this file:
        name = "kindlehub-api"
        main = "api-worker.js"
        compatibility_date = "2024-09-23"
        [[d1_databases]]
        binding = "DB"
        database_name = "kindlehub"
        database_id = "PASTE_THE_ID_HERE"
   4. wrangler deploy        (tables auto-create on first hit; to pre-load instead:
        wrangler d1 execute kindlehub --remote --file=schema-d1.sql  — this runs the
        WHOLE file reliably, unlike the dashboard editors.)

   FINALLY (either path): copy the Worker URL (https://kindlehub-api.YOURNAME.
   workers.dev) into KindleHub → Admin → Local Insights → "API gateway (Cloudflare
   D1)". Leave BLANK to keep using Supabase exactly as before.

   ENV VARS (Worker → Settings → Variables and Secrets)
   • GEMINI_KEY  — (optional) a Google AI Studio key. Set this and the Worker also
     hosts the shared-key AI proxy at /functions/v1/kh-gemini-proxy (ported off the
     Supabase Edge Function), so the WHOLE backend is Cloudflare — no Edge Function
     needed. The key never reaches the client.
   • DAILY_CAP   — (optional) shared-proxy daily request cap (default 3580).
   • ALLOW_ORIGIN— (optional) CORS origin allow-list (default '*').
   • MOD_HASHES   — (optional, LEGACY manual path) comma-separated SHA-256 hashes
     of moderator codes, set by hand as a Worker env var. SUPERSEDED by the
     turnkey IN-APP grant system below (no env var, no redeploy, nothing to
     copy/paste server-side): the admin panel's "Moderators" card generates a
     one-time invite code, the trusted person enters it in Settings → Account →
     Moderator tools (creating a pending request), and the admin Accepts /
     Declines it right there — see the kh_mod_grants table and the kh_mod_create
     / kh_mod_claim / kh_mod_list / kh_mod_approve / kh_mod_decline / kh_mod_revoke
     RPCs below. MOD_HASHES still works for anyone already using it (purely
     additive, checked first). Either way, a mod token unlocks kh_mod_stats
     (aggregate community COUNTS only) plus kh_ban_username / kh_unban_username /
     kh_warn_username — EXCEPT a non-admin mod can NEVER ban or warn an admin
     account (server-enforced, see isProtectedAdminName). Admins are always mods.
   • KH_PEPPER   — (optional, RECOMMENDED) envelope-at-rest secret. When set, the
     Worker wraps the sensitive ciphertext columns (kh_users.state, kh_mail
     subject/body, kh_messages.text) with AES-GCM keyed by this value BEFORE
     writing to D1, and unwraps on read. A STOLEN D1 database is then useless
     without this secret (which never lives in the DB) — the "encrypted with a
     key held outside the storage" model. It's an OUTER layer over the existing
     client E2E encryption, so there is NO client change and NO account-lockout
     risk. Opt-in: unset = exact previous behaviour. Legacy rows written before
     you set it keep working (they're wrapped on their next write).
     ⚠ Once set, KEEP IT PERMANENTLY. Losing or changing KH_PEPPER makes every
     already-wrapped row (all state/mail/chat) permanently unreadable. Use a long
     random value (e.g. `openssl rand -hex 32`) and store it somewhere safe.

   SECURITY (mirrors the Supabase RLS model it replaces)
   • Reads + most inserts are open — same as the public anon key + permissive
     RLS. The data that matters is end-to-end encrypted on the device first.
   • Admin-only writes (announcements, bans) require the admin token, checked
     by SHA-256 against ADMIN_HASHES — identical to kh_is_admin() in Postgres.
   • Editing/deleting a chat message or unsending mail requires the per-row
     owner_secret via the X-KH-Secret header — identical to the owner_secret
     RLS policies.
   ───────────────────────────────────────────────────────────────────────── */

const ADMIN_HASHES = ['ee99b2d35c0b10d4ef4ff70fba40ba621c17d12fbfd6c61c82e8dc05721f869c'];

/* Known schema — used to validate identifiers (no binding for column/table
   names is possible, so everything is whitelisted) and to marshal types. */
const COLUMNS = {
  kh_users:['hash','email','state','updated_at'],
  kh_groups:['code','name','creator','created_at','updated_at'],
  kh_messages:['id','group_code','user_id','display_name','text','ts','reply_to','edited','important','pinned','reactions','device_hint','location_hint','owner_secret'],
  kh_mail:['id','to_user','from_user','from_id','subject','body','ts','reply_to','owner_secret'],
  kh_feedback:['id','type','text','votes','status','author','comments','status_at','date'],
  kh_errors:['id','text','kind','date'],
  kh_scores:['id','game','score','display_name','user_id','date'],
  kh_announcements:['id','text','active','targets','created_at','comments'],
  kh_presence:['user_id','display_name','last_seen'],
  kh_shared_api_usage:['date','count'],
  kh_banned_usernames:['name','reason','created_at'],
  kh_visits:['device_id','day','last_seen','ua_hint','country','city'],
  kh_rate:['bucket','win_start','n'],
  kh_store_apps:['id','name','html','cat','author','model','created_at','downloads','owner_secret'],
};
const PK = {
  kh_users:['hash'], kh_groups:['code'], kh_messages:['id'], kh_mail:['id'],
  kh_feedback:['id'], kh_errors:['id'], kh_scores:['id'], kh_announcements:['id'],
  kh_presence:['user_id'], kh_shared_api_usage:['date'], kh_banned_usernames:['name'],
  kh_visits:['device_id','day'], kh_rate:['bucket'], kh_store_apps:['id'],
};
const JSON_COLS = { kh_messages:['reactions'], kh_announcements:['targets','comments'], kh_feedback:['comments'] };
const BOOL_COLS = { kh_messages:['edited','important','pinned'], kh_announcements:['active'] };
const INT_COLS  = new Set(['score','votes','count','n','downloads']);
const TS_COLS   = new Set(['updated_at','ts','created_at','date','last_seen']);
/* RLS equivalents: which tables accept a direct (anon) INSERT / open UPDATE. */
const INSERT_OK = new Set(['kh_users','kh_groups','kh_messages','kh_mail','kh_feedback','kh_errors','kh_scores','kh_presence','kh_visits','kh_store_apps']);
/* Open (anon) UPDATE. kh_groups was REMOVED: the client never PATCHes a group
   (it only INSERTs on create), and an open update let anyone enumerate room
   codes then rename / re-own every room. */
const UPDATE_OK = new Set(['kh_users','kh_feedback','kh_presence','kh_announcements']); // open update (kh_announcements: comments only for non-admin, gated below)
const SECRET_UPDATE = new Set(['kh_messages']);          // owner_secret-gated update
const SECRET_DELETE = new Set(['kh_messages','kh_mail','kh_store_apps']); // owner_secret-gated delete (store: an author removes their own published app)
/* Reads that expose cross-user PLAINTEXT (not E2E-encrypted) → admin-only.
   kh_rate stores one bucket per room ('msg:'+group_code); an open read would
   leak every active room's code (= its chat decryption key), so it's gated too.
   The client never reads these tables via REST. */
const ADMIN_READ = new Set(['kh_visits','kh_errors','kh_rate']);
/* Tables a NON-admin may legitimately UPSERT (on_conflict). Any other table's
   conflict target is stripped for non-admins so a colliding INSERT errors
   instead of silently UPDATING an existing row — otherwise on_conflict is an
   unauthenticated UPDATE primitive that bypasses owner_secret / the kh_groups
   update lockdown. kh_groups/kh_messages upserts happen only in admin migration
   (X-KH-Admin). Verified: the client only upserts these three. */
const UPSERT_OK = new Set(['kh_users','kh_presence','kh_visits']);
/* Replicates the client's _mailNorm(email) → mail username, used to verify a
   mail reader owns the mailbox it queries. Keep in sync with index.html. */
function mailNorm(u){ return String(u||'').trim().toLowerCase().replace(/@.*$/,'').slice(0,40); }

function cors(env){
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOW_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer, x-kh-secret, x-kh-admin, range, range-unit, accept',
    'Access-Control-Expose-Headers': 'Content-Range, x-kh-count, x-kh-cap, x-kh-load',  // _sbCount total + shared-AI cap + fleet-backoff load
    'X-KH-Load': String(Math.min(100, Math.round(_loadFrac*100))),  // % of daily free budget used → clients self-throttle
    'Access-Control-Max-Age': '86400',
  };
}
function json(body, status, env, extra){
  return new Response(body===null?null:JSON.stringify(body), {
    status: status||200,
    headers: Object.assign({'Content-Type':'application/json'}, cors(env), extra||{}),
  });
}
function err(message, status, env){ return json({ message: String(message||'error') }, status||400, env); }

async function sha256hex(s){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s||''));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
/* SECURITY: the hardcoded ADMIN_HASHES is SHA-256 of the admin's login username,
   which is PUBLIC — so anyone sending that username as X-KH-Admin would pass. Set
   a random ADMIN_SECRET on the Worker to ROTATE off the username: once it's set,
   ONLY that secret grants admin and the username hash stops working. Unset = the
   legacy username hash (backward-compatible, nothing breaks until you rotate). */
let _ADMIN_SECRET_HASH=null,_ADMIN_SECRET_SEEN;
async function _syncAdminSecret(env){
  const s=(env&&env.ADMIN_SECRET)||'';
  if(s!==_ADMIN_SECRET_SEEN){ _ADMIN_SECRET_SEEN=s; _ADMIN_SECRET_HASH = s ? await sha256hex(s) : null; }
}
async function isAdmin(token){
  const h = await sha256hex(token||'');
  if(_ADMIN_SECRET_HASH) return h===_ADMIN_SECRET_HASH;
  return ADMIN_HASHES.indexOf(h) >= 0;
}
/* Limited MODERATOR role. A mod token unlocks ONLY the kh_mod_stats RPC
   (aggregate counts — never rows, user data, mail or message bodies) plus
   kh_ban_username / kh_unban_username / kh_warn_username — never anything else;
   every privileged path still checks isAdmin first. A token can become a valid
   mod in TWO ways (checked in this order, first match wins):
   1. LEGACY: the Worker env `MOD_HASHES` (comma-separated SHA-256 of each mod's
      code) — a manual, redeploy-to-revoke path kept for anyone already using it.
   2. TURNKEY (new): a row in kh_mod_grants with status='active'. The admin
      generates a one-time invite code in the app (kh_mod_create), the trusted
      person enters it (kh_mod_claim flips it to 'requested'), and the admin
      Accepts it (kh_mod_approve flips it to 'active') — all from the UI, no env
      var, no redeploy. kh_mod_revoke flips it to 'revoked' and the SAME code
      stops passing this check immediately.
   DB is optional so old callers that don't pass one just skip step 2 (env-only
   behaviour, unchanged); a missing/broken kh_mod_grants table fails CLOSED
   (returns false from the try/catch) rather than throwing. Admins are always
   implicitly mods (checked first, so an admin's own token never depends on
   either mod path). */
async function isMod(token, env, DB){
  if(await isAdmin(token)) return true;
  const h = await sha256hex(token||'');
  const raw = (env && env.MOD_HASHES) || '';
  if(raw && raw.split(',').map(s=>s.trim()).filter(Boolean).indexOf(h) >= 0) return true;
  if(DB){
    try{
      const row = await DB.prepare("SELECT id FROM kh_mod_grants WHERE code_hash=? AND status='active'").bind(h).first();
      if(row) return true;
    }catch(_){ /* table missing / DB error → fail closed, never throw */ }
  }
  return false;
}
/* PROTECT THE ADMIN: a granted moderator's code must NEVER be able to ban or
   warn an actual admin account (defence against a mod "turning evil"). Names
   are compared lowercase/trimmed. The set is env `ADMIN_USERNAMES` (comma-sep,
   same var the auto-moderator already uses to skip admins) PLUS the two
   hardcoded aliases that are already one admin account (see
   _khCanonicalUsername in index.html: 'aran' <-> 'arancool3000'). Admins
   themselves bypass this check entirely (they may moderate anyone, including
   another admin) — only checked for a NON-admin caller. */
function isProtectedAdminName(name, env){
  const n = String(name||'').trim().toLowerCase();
  if(!n) return false;
  if(n==='arancool3000' || n==='aran') return true;
  const admins = String((env&&env.ADMIN_USERNAMES)||'').toLowerCase().split(',').map(function(s){return s.trim();}).filter(Boolean);
  return admins.indexOf(n) >= 0;
}

const QUOTE = id => '"'+String(id).replace(/"/g,'')+'"';
function nowIso(){ return new Date().toISOString(); }

/* ── envelope-at-rest (optional) ──────────────────────────────────────────────
   Wraps the sensitive ciphertext columns with a server-held pepper (KH_PEPPER
   env) so a STOLEN D1 database is useless without the Worker's secret. This is
   an OUTER layer on top of the existing client E2E encryption: state stays
   hash-encrypted, chat/mail stay group/recipient-encrypted — those inner keys
   sit in the DB (hash, group_code) so the DB alone would otherwise decrypt. The
   pepper does NOT live in the database, so an exfiltrated DB can't be unwrapped.
   Opt-in: if KH_PEPPER is unset it's a pure no-op (zero behaviour change).
   Backward-compatible: legacy un-prefixed rows pass through untouched on read,
   and get wrapped the next time they're written. ⚠ Once KH_PEPPER is set it must
   be kept PERMANENTLY — losing or changing it makes every wrapped row (state /
   mail / messages) permanently unreadable. The inner E2E layer is unchanged, so
   this adds no client change and no account-lockout risk. */
const WRAP_COLS = { kh_users:['state'], kh_mail:['subject','body'], kh_messages:['text'] };
const WRAP_PREFIX = 'KHW1:';
let _wrapKeyP = null, _wrapKeyFor = null;
function wrapKey(env){
  const p = (env && env.KH_PEPPER) || '';
  if(_wrapKeyFor===p && _wrapKeyP) return _wrapKeyP;
  _wrapKeyFor = p;
  _wrapKeyP = crypto.subtle.digest('SHA-256', new TextEncoder().encode('khpepper::'+p))
    .then(raw=>crypto.subtle.importKey('raw', raw, {name:'AES-GCM'}, false, ['encrypt','decrypt']));
  return _wrapKeyP;
}
function _b64enc(bytes){ let s=''; for(let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return btoa(s); }
function _b64dec(str){ const bin=atob(str), out=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i); return out; }
async function wrapCell(v, env){
  if(!(env && env.KH_PEPPER) || typeof v!=='string' || v==='' || v.slice(0,5)===WRAP_PREFIX) return v;
  const key = await wrapKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv}, key, new TextEncoder().encode(v)));
  const buf = new Uint8Array(iv.length+ct.length); buf.set(iv,0); buf.set(ct,iv.length);
  return WRAP_PREFIX+_b64enc(buf);
}
async function unwrapCell(v, env){
  if(!(env && env.KH_PEPPER) || typeof v!=='string' || v.slice(0,5)!==WRAP_PREFIX) return v;
  try{
    const key = await wrapKey(env);
    const buf = _b64dec(v.slice(5)), iv = buf.slice(0,12), ct = buf.slice(12);
    return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv}, key, ct));
  }catch(_){ return v; } // wrong pepper / corrupt → leave as-is rather than lose the row
}
async function unwrapRows(table, rows, env){
  const cols = WRAP_COLS[table];
  if(!(env && env.KH_PEPPER) || !cols) return rows;
  for(const r of rows){ for(const c of cols){ if(typeof r[c]==='string') r[c] = await unwrapCell(r[c], env); } }
  return rows;
}

/* ── type marshaling ─────────────────────────────────────────────────────── */
function rowOut(table, row){
  if(!row) return row;
  const jc = JSON_COLS[table]||[], bc = BOOL_COLS[table]||[];
  const o = {};
  for(const k in row){
    /* SECURITY: never serve owner_secret. It's the per-row token that gates
       editing/unsending a message or mail (X-KH-Secret). Returning it on a read
       would let anyone who can SELECT a row then edit/delete it. The client
       generates+keeps its own secret locally, so it never needs it back. */
    if(k==='owner_secret') continue;
    let v = row[k];
    if(jc.indexOf(k)>=0){ if(v==null){v=null;} else { try{ v = JSON.parse(v); }catch(_){ /* leave raw */ } } }
    else if(bc.indexOf(k)>=0){ v = (v===1||v==='1'||v===true); }
    o[k] = v;
  }
  return o;
}
function valIn(table, col, v){
  if((JSON_COLS[table]||[]).indexOf(col)>=0) return v==null?null:(typeof v==='string'?v:JSON.stringify(v));
  if((BOOL_COLS[table]||[]).indexOf(col)>=0) return (v===true||v===1||v==='true'||v==='1')?1:0;
  if(INT_COLS.has(col)){ const n=Number(v); return isNaN(n)?v:n; }
  return v;
}
function coerceFilter(table, col, raw){
  if((BOOL_COLS[table]||[]).indexOf(col)>=0) return (raw==='true'||raw==='1')?1:0;
  if(INT_COLS.has(col)){ const n=Number(raw); return isNaN(n)?raw:n; }
  return raw;
}

/* ── PostgREST query parsing ──────────────────────────────────────────────── */
function parseQuery(table, params){
  const cols = COLUMNS[table];
  const q = { selects:null, filters:[], orders:[], limit:null, offset:null, onConflict:null };
  for(const [key, rawVal] of params){
    if(key==='select'){
      if(rawVal==='*'){ q.selects=null; }
      else { q.selects = rawVal.split(',').map(s=>s.trim()).filter(c=>cols.indexOf(c)>=0); }
    } else if(key==='order'){
      rawVal.split(',').forEach(part=>{
        const [c,dir] = part.split('.');
        if(cols.indexOf(c)>=0) q.orders.push({col:c, dir:(dir==='desc'?'DESC':'ASC')});
      });
    } else if(key==='limit'){ const n=parseInt(rawVal,10); if(!isNaN(n)) q.limit=n; }
    else if(key==='offset'){ const n=parseInt(rawVal,10); if(!isNaN(n)) q.offset=n; }
    else if(key==='on_conflict'){ q.onConflict = rawVal.split(',').map(s=>s.trim()).filter(c=>cols.indexOf(c)>=0); }
    else if(cols.indexOf(key)>=0){
      /* a filter: value like "eq.x" / "ilike.*x*" / "in.(a,b)" / "not.like.x*" */
      let neg=false, s=rawVal;
      if(s.indexOf('not.')===0){ neg=true; s=s.slice(4); }
      const dot=s.indexOf('.');
      if(dot<0) continue;
      const op=s.slice(0,dot), val=s.slice(dot+1);
      q.filters.push({col:key, op, val, neg});
    }
  }
  return q;
}
function whereSql(table, filters){
  const parts=[], binds=[];
  for(const f of filters){
    const c = QUOTE(f.col);
    switch(f.op){
      case 'eq':  parts.push(c+(f.neg?' <> ?':' = ?')); binds.push(coerceFilter(table,f.col,f.val)); break;
      case 'neq': parts.push(c+' <> ?'); binds.push(coerceFilter(table,f.col,f.val)); break;
      case 'gt':  parts.push(c+' > ?');  binds.push(coerceFilter(table,f.col,f.val)); break;
      case 'gte': parts.push(c+' >= ?'); binds.push(coerceFilter(table,f.col,f.val)); break;
      case 'lt':  parts.push(c+' < ?');  binds.push(coerceFilter(table,f.col,f.val)); break;
      case 'lte': parts.push(c+' <= ?'); binds.push(coerceFilter(table,f.col,f.val)); break;
      case 'like':
      case 'ilike': /* SQLite LIKE is case-insensitive for ASCII — fine for both */
        parts.push(c+(f.neg?' NOT LIKE ?':' LIKE ?')); binds.push(String(f.val).replace(/\*/g,'%')); break;
      case 'in': {
        const items = f.val.replace(/^\(|\)$/g,'').split(',').map(s=>s.replace(/^"|"$/g,'')).map(v=>coerceFilter(table,f.col,v));
        if(!items.length){ parts.push('0'); break; }
        parts.push(c+(f.neg?' NOT IN (':' IN (')+items.map(()=>'?').join(',')+')'); items.forEach(v=>binds.push(v)); break;
      }
      case 'is':
        if(f.val==='null'){ parts.push(c+(f.neg?' IS NOT NULL':' IS NULL')); }
        else { parts.push(c+' = ?'); binds.push(coerceFilter(table,f.col,f.val)); }
        break;
      default: throw new Error('unsupported operator: '+f.op);
    }
  }
  return { sql: parts.length?(' WHERE '+parts.join(' AND ')):'', binds };
}

/* ── storage-cap triggers (ported from schema.sql) ───────────────────────── */
/* Per-group message ceiling: the single Global Chat room keeps the latest 50,
   every other room keeps 30 (mirrors KH_MSG_GLOBAL_CAP / KH_MSG_CAP_MAX in
   index.html). Keep these in sync if the client caps change. */
const GLOBAL_GROUP_CODE='000000000000';
const GLOBAL_MSG_CAP=50, GROUP_MSG_CAP=30;
async function applyCaps(DB, table, row){
  try{
    if(table==='kh_messages' && row && row.group_code){
      const keep = row.group_code===GLOBAL_GROUP_CODE ? GLOBAL_MSG_CAP : GROUP_MSG_CAP;
      await DB.prepare('DELETE FROM kh_messages WHERE group_code=? AND id NOT IN (SELECT id FROM kh_messages WHERE group_code=? ORDER BY ts DESC LIMIT '+keep+')').bind(row.group_code,row.group_code).run();
      /* Occasionally sweep EVERY room down to its cap — so rooms that stopped
         receiving messages, or that arrived via migration before the per-insert cap
         kicked in, don't keep old rows sitting in D1 storage. After convergence this
         deletes ~0 rows, so its write cost is negligible. (Window-function partition
         delete — SQLite/D1 support ROW_NUMBER() OVER.) The global room keeps 50. */
      if(Math.random()<0.03){ try{ await DB.prepare("DELETE FROM kh_messages WHERE rowid IN (SELECT rowid FROM (SELECT rowid, group_code, ROW_NUMBER() OVER (PARTITION BY group_code ORDER BY ts DESC) AS rn FROM kh_messages) WHERE rn > (CASE WHEN group_code='"+GLOBAL_GROUP_CODE+"' THEN "+GLOBAL_MSG_CAP+" ELSE "+GROUP_MSG_CAP+" END))").run(); }catch(_){} }
    } else if(table==='kh_mail' && row && row.to_user){
      await DB.prepare('DELETE FROM kh_mail WHERE to_user=? AND id NOT IN (SELECT id FROM kh_mail WHERE to_user=? ORDER BY ts DESC LIMIT 60)').bind(row.to_user,row.to_user).run();
    } else if(table==='kh_scores' && row && row.game){
      await DB.prepare('DELETE FROM kh_scores WHERE game=? AND id NOT IN (SELECT id FROM kh_scores WHERE game=? ORDER BY score DESC, date DESC LIMIT 100)').bind(row.game,row.game).run();
    } else if(table==='kh_feedback'){
      /* Auto-prune resolved feedback after 7 days so done/ignored bug reports +
         suggestions don't pile up in the cloud. COALESCE(status_at, date) ages out
         legacy rows that were resolved before status_at existed (by creation date).
         Runs on every feedback insert — one bounded DELETE, cheap. */
      const cut=new Date(Date.now()-7*86400000).toISOString();
      await DB.prepare("DELETE FROM kh_feedback WHERE status IN ('done','ignored') AND COALESCE(status_at, date) < ?").bind(cut).run();
    } else if(table==='kh_errors'){
      if(Math.random()<0.05) await DB.prepare('DELETE FROM kh_errors WHERE id NOT IN (SELECT id FROM kh_errors ORDER BY date DESC LIMIT 600)').run();
    } else if(table==='kh_presence'){
      if(Math.random()<0.05){ const cut=new Date(Date.now()-3*86400000).toISOString(); await DB.prepare('DELETE FROM kh_presence WHERE last_seen < ?').bind(cut).run(); }
    }
  }catch(_){/* caps are best-effort */}
}
async function checkRate(DB, bucket, max, windowSecs){
  try{
    const now=Date.now();
    const r=await DB.prepare('SELECT win_start,n FROM kh_rate WHERE bucket=?').bind(bucket).first();
    if(!r){ await DB.prepare('INSERT INTO kh_rate(bucket,win_start,n) VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET n=n+1').bind(bucket,String(now)).run(); return true; }
    const winStart=Number(r.win_start)||now;
    if(now-winStart > windowSecs*1000){ await DB.prepare('UPDATE kh_rate SET win_start=?, n=1 WHERE bucket=?').bind(String(now),bucket).run(); return true; }
    if((r.n||0) >= max) return false;
    await DB.prepare('UPDATE kh_rate SET n=n+1 WHERE bucket=?').bind(bucket).run();
    return true;
  }catch(_){ return true; }
}

/* ── representation helper: re-read rows by PK after a write ──────────────── */
async function selectByPk(DB, table, pkVals){
  const pk = PK[table];
  const where = pk.map(c=>QUOTE(c)+'=?').join(' AND ');
  const r = await DB.prepare('SELECT * FROM '+QUOTE(table)+' WHERE '+where).bind(...pk.map(c=>pkVals[c])).first();
  return r?rowOut(table,r):null;
}

/* ── RPCs (ported from the SECURITY DEFINER functions) ───────────────────── */
async function handleRpc(fn, body, DB, env, request){
  body = body||{};
  /* Some RPCs (kh_add_comment / kh_vote_feedback) read the admin token from the
     X-KH-Admin header to bypass the per-id rate limit; guard for a missing
     request (older callers / tests) so header reads never throw. */
  request = request || { headers:{ get:function(){return '';} } };
  if(fn==='kh_store_download'){
    /* Atomic download counter for a shared-store app (drives the ranking).
       Open to anyone — it only ever increments a public counter by 1. */
    if(!body.p_id) return err('missing id',400,env);
    try{ await DB.prepare('UPDATE kh_store_apps SET downloads=COALESCE(downloads,0)+1 WHERE id=?').bind(String(body.p_id)).run(); }catch(_){}
    return json(true, 200, env);
  }
  if(fn==='kh_mod_stats'){
    /* Limited moderator dashboard: aggregate COUNTS only. Returns numbers, never
       rows — no usernames, emails, message/mail bodies or state blobs — so a
       moderator can see how the community is doing without any access to user or
       cloud data. Gated by isMod (admins included). */
    if(!await isMod(body.p_token, env, DB)) return err('unauthorized',403,env);
    const one = async (sql, binds) => { try{ const r = await DB.prepare(sql).bind(...(binds||[])).first(); return (r && typeof r.c==='number') ? r.c : 0; }catch(_){ return 0; } };
    const today = nowIso().slice(0,10);
    const d7 = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
    const onlineSince = new Date(Date.now()-150000).toISOString();
    return json({
      users:        await one('SELECT COUNT(*) c FROM kh_users'),
      messages:     await one('SELECT COUNT(*) c FROM kh_messages'),
      groups:       await one('SELECT COUNT(*) c FROM kh_groups'),
      mail:         await one('SELECT COUNT(*) c FROM kh_mail'),
      visitsToday:  await one('SELECT COUNT(*) c FROM kh_visits WHERE day=?',[today]),
      visitors7d:   await one('SELECT COUNT(DISTINCT device_id) c FROM kh_visits WHERE day>=?',[d7]),
      onlineNow:    await one("SELECT COUNT(*) c FROM kh_presence WHERE last_seen>=? AND user_id NOT LIKE 'sl\\_%' ESCAPE '\\'",[onlineSince]),
      feedbackOpen: await one("SELECT COUNT(*) c FROM kh_feedback WHERE status='open' OR status IS NULL"),
      day: today,
    }, 200, env);
  }
  if(fn==='kh_post_announcement'){
    if(!await isAdmin(body.p_token)) return err('unauthorized',403,env);
    if(!body.p_text) return err('empty text',400,env);
    const targets = body.p_targets==null?'[]':(typeof body.p_targets==='string'?body.p_targets:JSON.stringify(body.p_targets));
    const res = await DB.prepare('INSERT INTO kh_announcements(text,active,targets,created_at) VALUES(?,1,?,?)').bind(String(body.p_text), targets, nowIso()).run();
    const id = res.meta && res.meta.last_row_id;
    return json(id||0, 200, env);
  }
  if(fn==='kh_clear_announcements'){
    if(!await isAdmin(body.p_token)) return err('unauthorized',403,env);
    const res = await DB.prepare('UPDATE kh_announcements SET active=0 WHERE active=1').run();
    return json((res.meta&&res.meta.changes)||0, 200, env);
  }
  if(fn==='kh_delete_announcement'){
    if(!await isAdmin(body.p_token)) return err('unauthorized',403,env);
    const res = await DB.prepare('DELETE FROM kh_announcements WHERE id=?').bind(body.p_id).run();
    return json((res.meta&&res.meta.changes)||0, 200, env);
  }
  if(fn==='kh_ban_username'){
    if(!await isMod(body.p_token, env, DB)) return err('not authorized',403,env);
    const _tgt = String(body.p_name||'').trim().toLowerCase();
    /* PROTECT THE ADMIN: a non-admin mod (their code turned evil, or just a
       mistake) can never ban an actual admin account. Admins themselves are
       exempt from this check (they may ban anyone, incl. another admin). */
    if(_tgt && !(await isAdmin(body.p_token)) && isProtectedAdminName(_tgt, env)) return err('cannot moderate an admin',403,env);
    await DB.prepare('INSERT INTO kh_banned_usernames(name,reason,created_at) VALUES(?,?,?) ON CONFLICT(name) DO NOTHING').bind(_tgt,'admin',nowIso()).run();
    return json(null,204,env);
  }
  if(fn==='kh_unban_username'){
    if(!await isMod(body.p_token, env, DB)) return err('not authorized',403,env);
    await DB.prepare('DELETE FROM kh_banned_usernames WHERE name=?').bind(String(body.p_name||'').trim().toLowerCase()).run();
    return json(null,204,env);
  }
  if(fn==='kh_warn_username'){
    /* Moderator OR admin: deliver a PRIVATE warning to ONE named user. This is a
       locked-down wrapper over the announcement table — the server FORCES the
       warn tag + a single-username target, so a mod can only ever warn one named
       user and can NEVER post a broadcast/general announcement (that stays
       admin-only via kh_post_announcement). Text mirrors the client _WARN_TAG. */
    if(!await isMod(body.p_token, env, DB)) return err('unauthorized',403,env);
    const target = String(body.p_name||'').trim().toLowerCase();
    if(!target) return err('missing username',400,env);
    /* PROTECT THE ADMIN — same rule as kh_ban_username above. */
    if(!(await isAdmin(body.p_token)) && isProtectedAdminName(target, env)) return err('cannot moderate an admin',403,env);
    const reason = (String(body.p_reason||'').trim().slice(0,600)) || 'Please follow the community rules.';
    const wtext = '[[KH_WARN]]WARNING from the moderators\n\n'+reason+'\n\nThis is a warning, not a ban — but repeated issues may lead to your account being banned.';
    const wres = await DB.prepare('INSERT INTO kh_announcements(text,active,targets,created_at) VALUES(?,1,?,?)').bind(wtext.slice(0,1000), JSON.stringify([target]), nowIso()).run();
    const wid = wres.meta && wres.meta.last_row_id;
    return json(wid||0, 200, env);
  }
  /* ── Turnkey in-app moderator GRANT lifecycle ─────────────────────────────
     Six RPCs implementing "generate a one-time invite code -> the trusted
     person enters it -> a pending request appears for the admin to Accept or
     Decline -> the admin can later Revoke". See the isMod() doc comment above
     for how an 'active' row feeds back into every mod-gated RPC. */
  if(fn==='kh_mod_create'){
    /* ADMIN only. The client generates a random plaintext code itself and sends
       ONLY its SHA-256 — the plaintext never touches the server, exactly like a
       password hash. Starts 'pending' (nobody has entered it yet). */
    if(!await isAdmin(body.p_token)) return err('unauthorized',403,env);
    const hash = String(body.p_code_hash||'');
    if(!/^[0-9a-f]{64}$/.test(hash)) return err('invalid code hash',400,env);
    try{
      const res = await DB.prepare('INSERT INTO kh_mod_grants(code_hash,status,created_at) VALUES(?,?,?)').bind(hash,'pending',nowIso()).run();
      return json({id:(res.meta&&res.meta.last_row_id)||0}, 200, env);
    }catch(e){ return err('could not create invite code — try again',400,env); }
  }
  if(fn==='kh_mod_claim'){
    /* PUBLIC — no auth (anyone with the code can claim it; that's the point).
       Enforces ONE-TIME use with a single WHERE clause: only a row still
       'pending' matches, so a code that's already been requested, made active,
       or revoked simply won't match and this becomes a no-op ({ok:false}). No
       race window beyond SQLite's own single-writer semantics. */
    const hash = String(body.p_code_hash||'');
    if(!hash) return err('missing code',400,env);
    const name = String(body.p_name||'').trim().slice(0,60) || 'Anonymous';
    const uid = String(body.p_uid||'').trim().slice(0,32);
    const res = await DB.prepare("UPDATE kh_mod_grants SET status='requested', requester_name=?, requester_uid=?, claimed_at=? WHERE code_hash=? AND status='pending'").bind(name, uid, nowIso(), hash).run();
    const changed = !!(res && res.meta && res.meta.changes);
    return json({ok:changed}, 200, env);
  }
  if(fn==='kh_mod_list'){
    /* ADMIN only. Never returns code_hash — the admin reviews WHO is asking,
       not the secret itself (matches the "never serve owner_secret"-style rule
       used elsewhere in this file). */
    if(!await isAdmin(body.p_token)) return err('unauthorized',403,env);
    const res = await DB.prepare("SELECT id,status,requester_name,requester_uid,created_at,claimed_at FROM kh_mod_grants WHERE status IN ('pending','requested','active') ORDER BY id DESC").all();
    return json((res && res.results) || [], 200, env);
  }
  if(fn==='kh_mod_approve'){
    /* ADMIN only. Only flips a row that is still 'requested' — approving an
       already-active/revoked/unknown id is a no-op (404), not an error state a
       double-click could corrupt. */
    if(!await isAdmin(body.p_token)) return err('unauthorized',403,env);
    const res = await DB.prepare("UPDATE kh_mod_grants SET status='active', approved_at=? WHERE id=? AND status='requested'").bind(nowIso(), body.p_id).run();
    if(!res || !res.meta || !res.meta.changes) return err('not found or not pending review',404,env);
    return json({ok:true}, 200, env);
  }
  if(fn==='kh_mod_decline'){
    /* ADMIN only. Removes the request outright (nothing worth keeping — the
       person can be re-invited with a fresh code any time). */
    if(!await isAdmin(body.p_token)) return err('unauthorized',403,env);
    const res = await DB.prepare("DELETE FROM kh_mod_grants WHERE id=? AND status='requested'").bind(body.p_id).run();
    if(!res || !res.meta || !res.meta.changes) return err('not found or not pending review',404,env);
    return json({ok:true}, 200, env);
  }
  if(fn==='kh_mod_revoke'){
    /* ADMIN only. Sets 'revoked' (keeps the row for an audit trail) rather than
       deleting — after this the SAME code immediately stops passing isMod().
       Not restricted to status='active' so an admin can also cancel a stray
       pending/requested code before it's ever used. */
    if(!await isAdmin(body.p_token)) return err('unauthorized',403,env);
    const res = await DB.prepare("UPDATE kh_mod_grants SET status='revoked' WHERE id=?").bind(body.p_id).run();
    return json({ok:!!(res && res.meta && res.meta.changes)}, 200, env);
  }
  if(fn==='kh_increment_shared_api'){
    const d = String(body.p_date||nowIso().slice(0,10));
    /* SECURITY: this is a public, unauthenticated RPC, so an attacker could loop
       it to inflate the shared-AI usage counter and deny AI service to everyone.
       Cap per-IP daily increments (a legit heavy user makes at most a few dozen
       shared calls/day); past the cap just RETURN the current count WITHOUT
       incrementing, so one source can't burn the shared allowance. rlHit fails
       open if the Cache API is unavailable, so legit traffic is never blocked. */
    try{
      var _sip=(request&&request.headers&&request.headers.get('cf-connecting-ip'))||'0';
      if(await rlHit(_sip, (parseInt((env&&env.SHARED_INCR_CAP)||'',10)||80), 86400, 'sai')){
        const rc = await DB.prepare('SELECT count FROM kh_shared_api_usage WHERE date=?').bind(d).first();
        return json((rc&&rc.count)||0, 200, env);
      }
    }catch(_e){}
    await DB.prepare('INSERT INTO kh_shared_api_usage(date,count) VALUES(?,1) ON CONFLICT(date) DO UPDATE SET count=count+1').bind(d).run();
    const r = await DB.prepare('SELECT count FROM kh_shared_api_usage WHERE date=?').bind(d).first();
    return json((r&&r.count)||0, 200, env);
  }
  if(fn==='kh_set_reaction'){
    const key=String(body.p_key||''), uid=String(body.p_user_id||'');
    if(key.length<1||key.length>20) return err('invalid reaction key',400,env);
    if(uid.length<1||uid.length>100) return err('invalid user id',400,env);
    const r = await DB.prepare('SELECT reactions FROM kh_messages WHERE id=?').bind(String(body.p_msg_id||'')).first();
    if(!r) return json(null,204,env);
    let cur={}; try{ cur=JSON.parse(r.reactions||'{}')||{}; }catch(_){ cur={}; }
    let list = Array.isArray(cur[key])?cur[key]:[];
    const adding = list.indexOf(uid)<0;
    if(adding){
      /* Bound reaction bloat: an unauth caller could otherwise grow one row's
         reactions JSON without limit (storage + egress abuse). Cap distinct
         emoji keys per message and users per key. */
      if(!cur[key] && Object.keys(cur).length>=40) return json(null,204,env);
      if(list.length>=200) return json(null,204,env);
      list = list.concat([uid]);
    } else { list = list.filter(v=>v!==uid); }
    if(list.length===0) delete cur[key]; else cur[key]=list;
    await DB.prepare('UPDATE kh_messages SET reactions=? WHERE id=?').bind(JSON.stringify(cur), String(body.p_msg_id||'')).run();
    return json(null,204,env);
  }
  /* Atomic comment append. Non-admins comment through THIS RPC instead of a
     full-column PATCH of `comments`, which was a read-modify-write: two comments
     in the same second lost-updated (last write wins), and a crafted request
     could send comments=[] (wipe the thread) or a forged-author array. Here the
     server sanitizes the ONE comment and appends it in a SINGLE UPDATE via
     json_insert(…,'$[#]',…) — no client array, no race, nothing to wipe. */
  if(fn==='kh_add_comment'){
    const table = body.p_table==='kh_feedback' ? 'kh_feedback' : (body.p_table==='kh_announcements' ? 'kh_announcements' : '');
    if(!table) return err('invalid table',400,env);
    const id = String(body.p_id||''); if(!id) return err('missing id',400,env);
    const c = body.p_comment; if(!c || typeof c!=='object') return err('invalid comment',400,env);
    const text = String(c.text||'').slice(0,500); if(!text.replace(/\s/g,'')) return err('empty comment',400,env);
    const comment = { id:String(c.id||('c_'+Date.now().toString(36))).slice(0,40), author:String(c.author||'Anon').slice(0,40), text:text, date:nowIso() };
    if(!(await isAdmin(request.headers.get('x-kh-admin')||''))){
      if(!await checkRate(DB,'cmt:'+id.slice(0,40),12,60)) return err('Commenting too fast — try again shortly.',429,env);
    }
    const upd = await DB.prepare("UPDATE "+QUOTE(table)+" SET comments = json_insert(CASE WHEN json_valid(COALESCE(comments,'[]')) THEN COALESCE(comments,'[]') ELSE '[]' END, '$[#]', json(?)) WHERE id=?").bind(JSON.stringify(comment), id).run();
    if(!upd || !upd.meta || !upd.meta.changes) return err('not found',404,env);
    /* Trim to the newest 60 (drop oldest while over) so a thread can't grow without bound. */
    try{
      let row = await DB.prepare("SELECT json_array_length(comments) n FROM "+QUOTE(table)+" WHERE id=?").bind(id).first();
      let n=(row&&row.n)||0, guard=0;
      while(n>60 && guard++<400){ await DB.prepare("UPDATE "+QUOTE(table)+" SET comments=json_remove(comments,'$[0]') WHERE id=?").bind(id).run(); n--; }
    }catch(_){}
    return json({ok:true,comment:comment},200,env);
  }
  /* Atomic vote — votes = MAX(0, votes + delta) in ONE UPDATE, so a concurrent
     vote can't be lost by a client sending a stale absolute count. The delta is
     CLAMPED to the only legit toggle values {-2,-1,1,2} (up/down, switch, or
     un-vote), so a client can't inflate a count; per-device single-vote is still
     enforced client-side (kh_voted). */
  if(fn==='kh_vote_feedback'){
    const id = String(body.p_id||''); if(!id) return err('missing id',400,env);
    let delta = parseInt(body.p_delta,10); if(isNaN(delta)) delta=1;
    if(delta>2) delta=2; if(delta<-2) delta=-2; if(delta===0) delta=1;
    if(!(await isAdmin(request.headers.get('x-kh-admin')||''))){
      if(!await checkRate(DB,'vote:'+id.slice(0,40),20,60)) return err('Voting too fast.',429,env);
    }
    const upd = await DB.prepare("UPDATE kh_feedback SET votes=MAX(0,COALESCE(votes,0)+?) WHERE id=?").bind(delta,id).run();
    if(!upd || !upd.meta || !upd.meta.changes) return err('not found',404,env);
    const row = await DB.prepare("SELECT votes FROM kh_feedback WHERE id=?").bind(id).first();
    return json({ok:true,votes:(row&&row.votes)||0},200,env);
  }
  return err('unknown function: '+fn, 404, env);
}

/* ── main handlers ───────────────────────────────────────────────────────── */
async function handleGet(table, url, request, env, DB, headOnly){
  const q = parseQuery(table, url.searchParams);
  const cols = q.selects && q.selects.length ? q.selects.map(QUOTE).join(',') : '*';
  let { sql:where, binds } = whereSql(table, q.filters);

  /* ── Cross-user read gating ─────────────────────────────────────────────
     The open-read model is acceptable for E2E-encrypted bodies, but several
     tables expose PLAINTEXT cross-user data. Gate them. Compute admin once. */
  const _needAdminCheck = ADMIN_READ.has(table) || table==='kh_mail' || table==='kh_groups' || table==='kh_messages';
  const _adminGet = _needAdminCheck ? await isAdmin(request.headers.get('x-kh-admin')||'') : false;
  if(ADMIN_READ.has(table) && !_adminGet){
    return err('admin only', 403, env);   // kh_visits (geo/UA PII), kh_errors (logs), kh_rate (leaks room codes)
  }
  if(table==='kh_groups' && !_adminGet){
    /* Don't let anon dump every room's code+name (the code IS the join secret).
       A real member already knows the code, so require a code filter. */
    const hasCode = q.filters.some(f=>f.col==='code' && (f.op==='eq'||f.op==='in') && !f.neg);
    if(!hasCode) return err('a code filter is required', 400, env);
  }
  if(table==='kh_messages' && !_adminGet){
    /* Chat "E2E" keys are derived from the group_code alone, and every row pairs
       group_code + ciphertext, so an ungated read = dump+decrypt every chat AND
       harvest every room code. Require the query to be scoped to a specific room
       (group_code) or a specific message (id) — a member already knows the code,
       and the reaction path reads by id. Blocks only forged cross-room dumps. */
    const scoped = q.filters.some(f=>(f.col==='group_code'||f.col==='id') && (f.op==='eq'||f.op==='in') && !f.neg);
    if(!scoped) return err('a group_code or id filter is required', 400, env);
  }
  if(table==='kh_mail' && !_adminGet){
    /* Mail bodies are encrypted under a key derived from the recipient's public
       username, so an ungated read = anyone reads anyone's mailbox. Require the
       owner's auth secret and FORCE the query to the caller's own mail (received
       OR sent), regardless of the client-supplied filter. */
    const secret = (request.headers.get('x-kh-secret')||'').toLowerCase();
    if(!/^[0-9a-f]{64}$/.test(secret)) return err('mail read requires the owner secret', 403, env);
    const owner = await DB.prepare('SELECT email FROM kh_users WHERE hash=?').bind(secret).first();
    if(!owner || !owner.email) return err('unknown owner', 403, env);
    where += (where?' AND ':' WHERE ')+'(to_user = ? OR from_id = ?)';
    binds = binds.concat([mailNorm(owner.email), secret.slice(0,16)]);
  }

  /* count requested? (Prefer: count=exact, or a HEAD probe) */
  const prefer = (request.headers.get('prefer')||'');
  const wantCount = headOnly || /count=exact/i.test(prefer);
  let contentRange = null;
  if(wantCount){
    const c = await DB.prepare('SELECT COUNT(*) AS n FROM '+QUOTE(table)+where).bind(...binds).first();
    const total = (c&&c.n)||0;
    contentRange = '0-'+(total>0?total-1:0)+'/'+total;
    if(headOnly){
      return new Response(null, { status:200, headers: Object.assign({}, cors(env), {'Content-Range':contentRange}) });
    }
  }

  let sql = 'SELECT '+cols+' FROM '+QUOTE(table)+where;
  if(q.orders.length) sql += ' ORDER BY '+q.orders.map(o=>QUOTE(o.col)+' '+o.dir).join(',');
  /* Range header paging (used by _sbSelectAll) overrides limit/offset */
  const range = request.headers.get('range');
  if(range && /^\d+-\d+$/.test(range)){
    const [a,b] = range.split('-').map(Number);
    sql += ' LIMIT '+(b-a+1)+' OFFSET '+a;
  } else {
    if(q.limit!=null) sql += ' LIMIT '+q.limit;
    if(q.offset!=null) sql += ' OFFSET '+q.offset;
  }
  const res = await DB.prepare(sql).bind(...binds).all();
  let rows = (res.results||[]).map(r=>rowOut(table,r));
  /* SECURITY (critical): kh_users.hash IS the account's AES key (key == lookup),
     and .state is the encrypted blob. A blind `GET /kh_users?select=hash,state`
     would dump every account's key + ciphertext = full takeover of all accounts.
     So a read only gets the real hash + state if it PROVES it already knows the
     hash (exact `hash=eq.<64hex>` filter — i.e. the owner loading their own row)
     or is admin. Everyone else (e.g. the username search) gets a 16-char hash
     PREFIX — enough to derive the deterministic inbox code (first 6 hex) and
     group name (first 8) for invites, but NOT the full key — and NO state blob. */
  if(table==='kh_users'){
    const adminReq = await isAdmin(request.headers.get('x-kh-admin')||'');
    const hasHashEq = q.filters.some(f=>f.col==='hash' && f.op==='eq' && !f.neg);
    if(!adminReq && !hasHashEq){
      rows = rows.map(r=>{
        const o = Object.assign({}, r);
        if(typeof o.hash==='string' && o.hash.length>16) o.hash = o.hash.slice(0,16);
        delete o.state;
        return o;
      });
    }
  }
  /* kh_feedback holds public suggestions/bugs AND [USERNAME] abuse reports (which
     ride the bug board with a text marker). For non-admin reads, drop the abuse
     reports entirely (they name the reporter in `author` and quote the reported
     user) and strip moderator `comments`. Suggestions/bugs stay public. */
  if(table==='kh_feedback' && !(await isAdmin(request.headers.get('x-kh-admin')||''))){
    rows = rows
      .filter(r=>!(typeof r.text==='string' && (/\[USERNAME\]/.test(r.text) || /\[REPORT\]/.test(r.text))))
      .map(r=>{ const o=Object.assign({},r); delete o.comments; return o; });
  }
  /* envelope: unwrap sensitive columns for owner/admin reads (redacted rows
     already had the column deleted above, so this is a no-op for them). */
  await unwrapRows(table, rows, env);
  const extra = contentRange?{'Content-Range':contentRange}:null;
  return json(rows, 200, env, extra);
}

async function handlePost(table, url, request, env, DB){
  /* Admin-authenticated bulk writes (the data-migration tool) may seed tables
     that are otherwise insert-gated (announcements, bans) AND must bypass the
     per-group/feedback rate limits so the copy isn't throttled. The admin token
     is sent in X-KH-Admin, verified by SHA-256 against ADMIN_HASHES (same as the
     RPCs). Without it, behaviour is exactly as before. */
  const adminReq = await isAdmin(request.headers.get('x-kh-admin')||'');
  if(!INSERT_OK.has(table) && !adminReq) return err('insert not allowed on '+table, 403, env);
  let payload; try{ payload = await request.json(); }catch(_){ return err('bad json',400,env); }
  const rows = Array.isArray(payload)?payload:[payload];
  const cols = COLUMNS[table];
  const q = parseQuery(table, url.searchParams);
  let conflict = q.onConflict; // upsert target columns
  /* SECURITY: a non-admin must not UPSERT-overwrite an EXISTING kh_feedback row
     (an abuse report) — that scrubs it exactly like the PATCH vector. The client
     only ever plain-inserts feedback, so drop the conflict target for non-admins:
     a colliding id now errors instead of overwriting. Admin bulk writes keep it. */
  /* SECURITY: on_conflict is an UPDATE primitive. For a non-admin, only allow it
     on tables that legitimately upsert (kh_users/kh_presence/kh_visits); for any
     other table drop the conflict target so a colliding INSERT errors instead of
     silently overwriting an existing row. Without this, POST ?on_conflict=code to
     kh_groups re-owns any room, and ?on_conflict=id to kh_messages overwrites any
     message + seizes its owner_secret — bypassing the owner_secret / update gates. */
  if(!adminReq && !UPSERT_OK.has(table)) conflict=null;
  const prefer = (request.headers.get('prefer')||'');
  const minimal = /return=minimal/i.test(prefer);

  /* rate limits (ported from the BEFORE INSERT triggers) — skipped for admin
     bulk writes so the migration isn't throttled. */
  if(!adminReq) for(const row of rows){
    if(table==='kh_messages'){ if(!await checkRate(DB,'msg:'+(row.group_code||''),30,60)) return err('Rate limit exceeded — max 30 messages per group per minute',429,env); }
    if(table==='kh_feedback'){ if(!await checkRate(DB,'fb:'+(row.type||''),10,60)) return err('Rate limit exceeded — max 10 feedback submissions per minute',429,env); }
    if(table==='kh_store_apps'){
      /* Shared App Store publish: cap size (protect D1 + the free-tier budget)
         and rate-limit publishes so it can't be flooded. Apps are client-AI-
         reviewed before this call and always run sandboxed + CSP-locked. */
      if(String(row.html||'').length > 550000) return err('App is too large (max ~512 KB).',413,env);
      if(!await checkRate(DB,'store:pub',20,3600)) return err('Too many app publishes right now — try again shortly.',429,env);
    }
  }

  const out=[];
  for(const raw of rows){
    /* Stamp an approximate location on chat messages from Cloudflare's own edge
       geo (request.cf) — reliable, free, always present on the edge, and
       authoritative (the client can't spoof it, unlike a self-reported value).
       This replaces the flaky client-side ipapi.co lookup that returned empty on
       the first send of every session, which is why locations were usually
       blank. City granularity only. No cf (local/non-CF) → leave whatever the
       client sent as a fallback. */
    if(table==='kh_messages'){
      /* PRIVACY: COUNTRY-LEVEL ONLY. This app has child users, so city/region
         granularity over-collects location. Stamp just the (spoof-proof edge)
         country; for a client-supplied fallback keep only its country part. */
      const cf = request.cf || {};
      const _cc = String(cf.country||'').slice(0,4);
      if(_cc){ raw.location_hint = _cc; }
      else if(typeof raw.location_hint==='string'){ var _lp=raw.location_hint.split(','); raw.location_hint=String(_lp[_lp.length-1]||'').trim().slice(0,40); }
    }
    /* Leaderboard integrity: the score comes straight from the client, so clamp
       it to a sane non-negative integer (blocks MAX_INT / absurd injected scores
       that would permanently top every board) and bound the display name length
       (blocks oversized-payload abuse). */
    if(table==='kh_scores'){
      if(raw.score!=null){ let sc=Math.floor(Number(raw.score)); if(!isFinite(sc)||sc<0)sc=0; if(sc>999999999)sc=999999999; raw.score=sc; }
      if(typeof raw.display_name==='string') raw.display_name=raw.display_name.slice(0,40);
    }
    /* SECURITY: the D1 self-created schema didn't reproduce most of Supabase's
       per-field size limits, and these tables (messages/feedback/errors/presence/
       mail) allow anonymous insertion — so cap the length of EVERY string field
       before it reaches the DB, blocking oversized/malformed records that would
       burn D1 storage + request capacity. Per-field caps for the hot columns; a
       generous global cap for anything else. group_code is also format-restricted
       so junk can't spawn garbage rooms/partitions. */
    /* CRITICAL: several columns hold ENCRYPTED ciphertext — kh_users.state,
       kh_messages.text (also carries encrypted image/sticker/app-share media),
       kh_mail.subject/body. Truncating ciphertext makes it PERMANENTLY
       undecryptable (silent data loss), so we REJECT an oversized value with 413
       rather than slicing it. Caps are generous — a legit encrypted blob always
       passes; only genuinely abusive payloads trip it. (An earlier build sliced
       these at 4–6 KB, which corrupted large states and any media message — this
       replaces that.) */
    var _FMAX={
      state:16000000,            /* encrypted account blob — multi-MB */
      text:200000,               /* chat message incl. encrypted media */
      subject:8000, body:600000, /* encrypted mail (subject expands past plaintext) */
      html:600000, comments:60000, reactions:8000, targets:8000,
      message:8000, stack:8000, url:2000,
      display_name:4000,         /* Slither packs a presence beacon in here */
      user_id:200, group_code:24, device_hint:200, location_hint:200,
      from_user:200, to_user:200, from_id:200, to_id:200,
      name:200, reason:4000, ua_hint:400, city:120, country:16, day:16,
      author:200, email:320, hash:200, secret:200, owner_secret:200
    };
    for(var _fk in raw){ if(typeof raw[_fk]==='string' && raw[_fk].length > (_FMAX[_fk]||16000)){ return err('Field "'+_fk+'" exceeds the maximum size',413,env); } }
    if(typeof raw.group_code==='string')raw.group_code=raw.group_code.replace(/[^A-Za-z0-9_-]/g,'').slice(0,24);
    const keys = Object.keys(raw).filter(k=>cols.indexOf(k)>=0);
    /* default-fill timestamp columns the client omitted */
    for(const tc of TS_COLS){ if(cols.indexOf(tc)>=0 && keys.indexOf(tc)<0){ raw[tc]=nowIso(); keys.push(tc); } }
    const _wc = WRAP_COLS[table];
    const vals = [];
    for(const k of keys){
      let v = valIn(table,k,raw[k]);
      if(_wc && _wc.indexOf(k)>=0) v = await wrapCell(v, env);
      vals.push(v);
    }
    const colSql = keys.map(QUOTE).join(',');
    const ph = keys.map(()=>'?').join(',');
    let sql = 'INSERT INTO '+QUOTE(table)+'('+colSql+') VALUES('+ph+')';
    if(conflict && conflict.length){
      const upd = keys.filter(k=>conflict.indexOf(k)<0);
      sql += ' ON CONFLICT('+conflict.map(QUOTE).join(',')+') DO UPDATE SET '+(upd.length?upd.map(k=>QUOTE(k)+'=excluded.'+QUOTE(k)).join(','):QUOTE(conflict[0])+'='+QUOTE(conflict[0]));
    }
    const res = await DB.prepare(sql).bind(...vals).run();
    await applyCaps(DB, table, raw);
    if(!minimal){
      /* representation: re-read by PK (or by rowid for autoincrement ids) */
      const pk = PK[table];
      if(pk.every(c=>raw[c]!=null)){ const r=await selectByPk(DB,table,raw); if(r)out.push(r); }
      else { const rid=res.meta&&res.meta.last_row_id; if(rid){ const r=await DB.prepare('SELECT * FROM '+QUOTE(table)+' WHERE rowid=?').bind(rid).first(); if(r)out.push(rowOut(table,r)); } }
    }
  }
  if(minimal) return new Response(null,{status:201,headers:cors(env)});
  await unwrapRows(table, out, env); // representation must match a GET (plaintext)
  return json(out, 201, env);
}

async function handlePatch(table, url, request, env, DB){
  const secretGated = SECRET_UPDATE.has(table);
  if(!UPDATE_OK.has(table) && !secretGated) return err('update not allowed on '+table, 403, env);
  let patch; try{ patch = await request.json(); }catch(_){ return err('bad json',400,env); }
  const q = parseQuery(table, url.searchParams);
  /* SECURITY: an open (non-secret-gated) UPDATE must target a specific row by its
     primary key. Without this a `PATCH /kh_users` with no filter would rewrite
     EVERY user's row at once (mass vandalism); requiring an exact PK eq bounds the
     write to one identified row. Every client _sbUpdate already filters by PK
     (hash=eq / id=eq / code=eq), so this rejects only forged bulk writes. */
  if(!secretGated){
    const pkOk = (PK[table]||[]).length>0 && PK[table].every(pk=>q.filters.some(f=>f.col===pk && f.op==='eq' && !f.neg));
    if(!pkOk) return err('update requires an exact primary-key match', 400, env);
  }
  let { sql:where, binds } = whereSql(table, q.filters);
  if(secretGated){
    const secret = request.headers.get('x-kh-secret')||'';
    /* Require a real secret. Without a min length, a row that somehow had an
       empty owner_secret could be edited by anyone sending X-KH-Secret:''. */
    if(secret.length < 16) return err('a valid owner secret is required', 403, env);
    where += (where?' AND ':' WHERE ')+'owner_secret IS NOT NULL AND owner_secret = ?';
    binds = binds.concat([secret]);
  }
  const cols = COLUMNS[table];
  let keys = Object.keys(patch).filter(k=>cols.indexOf(k)>=0);
  /* SECURITY: kh_feedback holds abuse reports. A non-admin PATCH may ONLY bump
     `votes` (upvoting a suggestion) or append to `comments` (the public
     discussion thread on a bug/suggestion). Letting non-admins edit status/
     status_at/text/author/date would let a reported user dismiss their own
     report (status='ignored' hides it from the auto-mod cron + the human queue),
     strip the [USERNAME] marker to dodge the auto-moderator, backdate status_at
     to satisfy the 7-day delete guard, or forge `author` — those stay locked.
     `comments` is a discussion array, not a moderation signal, so allowing it is
     safe and restores commenting on your own bug report. Verified admins (the
     x-kh-admin token) may patch any column. */
  /* Non-admins get NO direct PATCH of kh_feedback / kh_announcements. Commenting
     and upvoting now go through the atomic kh_add_comment / kh_vote_feedback RPCs
     (server-side append/increment). The old allowance let a non-admin PATCH the
     whole `comments` array — a read-modify-write that lost-updated concurrent
     comments AND let a crafted request wipe the thread (comments=[]) or forge
     authors. Verified admins (x-kh-admin) may still patch any column. */
  if((table==='kh_feedback' || table==='kh_announcements') && !(await isAdmin(request.headers.get('x-kh-admin')||''))){
    keys = [];
  }
  if(!keys.length) return err('no valid columns to update',400,env);
  const setSql = keys.map(k=>QUOTE(k)+'=?').join(',');
  const _wc = WRAP_COLS[table];
  const setBinds = [];
  for(const k of keys){
    let v = valIn(table,k,patch[k]);
    if(_wc && _wc.indexOf(k)>=0) v = await wrapCell(v, env);
    setBinds.push(v);
  }
  await DB.prepare('UPDATE '+QUOTE(table)+' SET '+setSql+where).bind(...setBinds, ...binds).run();
  const prefer = (request.headers.get('prefer')||'');
  if(/return=minimal/i.test(prefer)) return new Response(null,{status:204,headers:cors(env)});
  /* representation: re-read the affected rows with the same WHERE (minus secret) */
  const r2 = whereSql(table, q.filters);
  const res = await DB.prepare('SELECT * FROM '+QUOTE(table)+r2.sql).bind(...r2.binds).all();
  const outRows = (res.results||[]).map(x=>rowOut(table,x));
  await unwrapRows(table, outRows, env); // representation must match a GET (plaintext)
  return json(outRows, 200, env);
}

/* Tables an authenticated ADMIN may delete rows from directly — moderation +
   diagnostics. (Chat/mail stay owner_secret-gated; kh_users is never here.) */
const ADMIN_DELETE_OK = new Set(['kh_feedback','kh_errors','kh_announcements','kh_scores','kh_banned_usernames','kh_visits','kh_presence','kh_store_apps']);
async function handleDelete(table, url, request, env, DB){
  const secretGated = SECRET_DELETE.has(table);
  const adminReq = await isAdmin(request.headers.get('x-kh-admin')||'');
  const adminOk = adminReq && ADMIN_DELETE_OK.has(table);
  /* Allowed if: owner-secret gated (chat/mail/store), the open kh_feedback prune
     path, OR an authenticated admin deleting from a moderation/store table. */
  if(!secretGated && table!=='kh_feedback' && !adminOk) return err('delete not allowed on '+table, 403, env);
  const q = parseQuery(table, url.searchParams);
  let { sql:where, binds } = whereSql(table, q.filters);
  if(adminOk){
    /* Admin deletes by filter alone (no owner secret) — used to purge store apps
       or moderation rows. A filter is still required below (except errors/presence)
       so a bug can't wipe a whole table. This takes precedence over the secret
       gate so an admin can remove rows that have no owner_secret (e.g. legacy
       store apps published before owner_secret existed). */
  } else if(secretGated){
    const secret = request.headers.get('x-kh-secret')||'';
    if(secret.length < 16) return err('a valid owner secret is required', 403, env);
    where += (where?' AND ':' WHERE ')+'owner_secret IS NOT NULL AND owner_secret = ?';
    binds = binds.concat([secret]);
  } else if(table==='kh_feedback' && !adminReq){
    /* NON-admin auto-prune ONLY: done/ignored items resolved (or, for legacy rows
       with no status_at, created) more than 7 days ago. An ADMIN skips this filter
       so they can delete ANY report/suggestion immediately (the bug where a fresh
       item's delete matched zero rows and silently "came back"). */
    const cut = new Date(Date.now()-7*86400000).toISOString();
    where += (where?' AND ':' WHERE ')+"status IN ('done','ignored') AND COALESCE(status_at, date) < ?";
    binds = binds.concat([cut]);
  }
  /* SAFETY: an admin "clear all" (no filter) is intentional for kh_errors; for
     other admin tables require a filter so a bug can't wipe a whole table. */
  if(adminOk && !where && table!=='kh_errors' && table!=='kh_presence')
    return err('a filter is required to delete from '+table, 400, env);
  await DB.prepare('DELETE FROM '+QUOTE(table)+where).bind(...binds).run();
  return new Response(null,{status:204,headers:cors(env)});
}

/* ── Schema self-bootstrap ───────────────────────────────────────────────────
   Creates every table/index on first use so the backend works the moment the
   Worker is deployed + a D1 database is bound — no separate "run schema-d1.sql"
   step. All statements are CREATE … IF NOT EXISTS (idempotent), so it's a safe
   no-op once the tables exist. Kept in sync with schema-d1.sql (still the canonical
   copy for manual/wrangler setup). Runs once per isolate (guarded by _schemaReady);
   on failure the flag stays false so the next request retries. This is the fix for
   the "D1_ERROR: no such table" flood when the schema was never applied. */
const SCHEMA_DDL = [
  "CREATE TABLE IF NOT EXISTS kh_users (hash TEXT PRIMARY KEY, email TEXT NOT NULL, state TEXT, updated_at TEXT)",
  "CREATE TABLE IF NOT EXISTS kh_groups (code TEXT PRIMARY KEY, name TEXT NOT NULL, creator TEXT DEFAULT '', created_at TEXT, updated_at TEXT)",
  "CREATE TABLE IF NOT EXISTS kh_messages (id TEXT PRIMARY KEY, group_code TEXT NOT NULL, user_id TEXT DEFAULT '', display_name TEXT DEFAULT '', text TEXT NOT NULL, ts TEXT, reply_to TEXT, edited INTEGER DEFAULT 0, important INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, reactions TEXT DEFAULT '{}', device_hint TEXT DEFAULT '', location_hint TEXT DEFAULT '', owner_secret TEXT)",
  "CREATE INDEX IF NOT EXISTS kh_messages_group_ts ON kh_messages(group_code, ts)",
  "CREATE TABLE IF NOT EXISTS kh_mail (id TEXT PRIMARY KEY, to_user TEXT NOT NULL, from_user TEXT DEFAULT '', from_id TEXT DEFAULT '', subject TEXT DEFAULT '', body TEXT DEFAULT '', ts TEXT, reply_to TEXT DEFAULT '', owner_secret TEXT)",
  "CREATE INDEX IF NOT EXISTS kh_mail_to_ts ON kh_mail(to_user, ts)",
  "CREATE INDEX IF NOT EXISTS kh_mail_from_ts ON kh_mail(from_id, ts)",
  "CREATE TABLE IF NOT EXISTS kh_feedback (id TEXT PRIMARY KEY, type TEXT NOT NULL, text TEXT NOT NULL, votes INTEGER DEFAULT 0, status TEXT DEFAULT 'open', author TEXT DEFAULT '', comments TEXT DEFAULT '[]', status_at TEXT, date TEXT)",
  "CREATE TABLE IF NOT EXISTS kh_errors (id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT DEFAULT 'error', date TEXT)",
  "CREATE TABLE IF NOT EXISTS kh_scores (id TEXT PRIMARY KEY, game TEXT NOT NULL, score INTEGER NOT NULL, display_name TEXT DEFAULT '', user_id TEXT DEFAULT '', date TEXT)",
  "CREATE INDEX IF NOT EXISTS kh_scores_game_score ON kh_scores(game, score DESC)",
  "CREATE TABLE IF NOT EXISTS kh_announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, active INTEGER DEFAULT 1, targets TEXT DEFAULT '[]', created_at TEXT, comments TEXT DEFAULT '[]')",
  "CREATE TABLE IF NOT EXISTS kh_presence (user_id TEXT PRIMARY KEY, display_name TEXT DEFAULT '', last_seen TEXT)",
  "CREATE INDEX IF NOT EXISTS kh_presence_last_seen ON kh_presence(last_seen DESC)",
  "CREATE TABLE IF NOT EXISTS kh_shared_api_usage (date TEXT PRIMARY KEY, count INTEGER DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS kh_banned_usernames (name TEXT PRIMARY KEY, reason TEXT DEFAULT '', created_at TEXT)",
  /* Turnkey in-app moderator invite/grant system — see isMod() and the
     kh_mod_create/claim/list/approve/decline/revoke RPCs. code_hash is the
     SHA-256 of a one-time plaintext invite code (plaintext never stored).
     status: pending -> requested -> active -> revoked. */
  "CREATE TABLE IF NOT EXISTS kh_mod_grants (id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT UNIQUE, status TEXT DEFAULT 'pending', requester_name TEXT, requester_uid TEXT, created_at TEXT, claimed_at TEXT, approved_at TEXT)",
  "CREATE INDEX IF NOT EXISTS kh_mod_grants_status ON kh_mod_grants(status)",
  "CREATE TABLE IF NOT EXISTS kh_visits (device_id TEXT NOT NULL, day TEXT NOT NULL, last_seen TEXT, ua_hint TEXT DEFAULT '', country TEXT DEFAULT '', city TEXT DEFAULT '', PRIMARY KEY (device_id, day))",
  "CREATE TABLE IF NOT EXISTS kh_rate (bucket TEXT PRIMARY KEY, win_start TEXT, n INTEGER DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS kh_daily (date TEXT PRIMARY KEY, n INTEGER DEFAULT 0, w INTEGER DEFAULT 0)",
  /* Shared App Store: apps published by any user, downloadable by everyone. */
  "CREATE TABLE IF NOT EXISTS kh_store_apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, html TEXT NOT NULL, cat TEXT DEFAULT 'Fun', author TEXT DEFAULT '', model TEXT DEFAULT '', created_at TEXT, downloads INTEGER DEFAULT 0, owner_secret TEXT)",
  "CREATE INDEX IF NOT EXISTS kh_store_apps_rank ON kh_store_apps(downloads DESC, created_at DESC)",
  /* Auto-maintenance bug queue: one row per distinct bug signature, persisted so
     the daily cron RESUMES tomorrow when Gemini free quota runs out. status:
     new | fixed | needs_review | wont_fix | deferred | failed */
  "CREATE TABLE IF NOT EXISTS kh_maint (sig TEXT PRIMARY KEY, status TEXT DEFAULT 'new', view TEXT DEFAULT '', err TEXT DEFAULT '', fix_kind TEXT DEFAULT '', fix_code TEXT DEFAULT '', detect TEXT DEFAULT '', confirm TEXT DEFAULT '', attempts INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)",
  "CREATE INDEX IF NOT EXISTS kh_maint_status ON kh_maint(status, updated_at)",
  /* Small admin-settable config (e.g. the maintenance key + on/off) so the admin
     can configure auto-maintenance from the app UI instead of Worker env vars.
     The maintenance key is stored envelope-wrapped when KH_PEPPER is set. */
  "CREATE TABLE IF NOT EXISTS kh_config (k TEXT PRIMARY KEY, v TEXT)",
];
let _schemaReady = false;
async function ensureSchema(DB){
  if(_schemaReady) return;
  let ok=false;
  try{ await DB.batch(SCHEMA_DDL.map(s=>DB.prepare(s))); ok=true; }
  catch(_){ /* some D1 versions reject DDL inside batch() — fall back to sequential */
    try{ for(const s of SCHEMA_DDL){ await DB.prepare(s).run(); } ok=true; }catch(_){}
  }
  if(!ok) return;            // leave _schemaReady=false so the next request retries
  // best-effort column migrations (CREATE…IF NOT EXISTS won't add a column to a
  // table that already exists from an earlier deploy). ALTER throws if it's there.
  try{ await DB.prepare("ALTER TABLE kh_daily ADD COLUMN w INTEGER DEFAULT 0").run(); }catch(_){}
  /* Announcement comments column for DBs created before this feature. */
  try{ await DB.prepare("ALTER TABLE kh_announcements ADD COLUMN comments TEXT DEFAULT '[]'").run(); }catch(_){}
  /* Store-app owner_secret for DBs created before authors could delete their apps. */
  try{ await DB.prepare("ALTER TABLE kh_store_apps ADD COLUMN owner_secret TEXT").run(); }catch(_){}
  _schemaReady=true;
}

/* ── Shared-key Gemini proxy (ported from the Supabase Edge Function) ─────────
   Same contract the client already speaks: POST {model, payload}. Holds the key
   in env.GEMINI_KEY, enforces a first-come/first-served daily cap via the same
   kh_shared_api_usage counter, and streams Gemini's SSE back. Env vars on the
   Worker: GEMINI_KEY (required), DAILY_CAP (optional, default 3580). */
const PROXY_MODELS = new Set([
  'gemini-3.1-flash-lite','gemini-2.5-flash-lite','gemini-2.5-flash',
  'gemini-3.5-flash','gemini-3.1-flash',
]);
/* Shared-proxy allow-list = the hard-coded PROXY_MODELS PLUS any live model the
   daily catalogue refresh discovered (cached in kh_config.model_live), so a
   newly-launched free Gemini model works through the shared key without a
   redeploy. Isolate-cached ~10 min to avoid a D1 read on every proxy call. Only
   NON-pro Gemini flash/lite ids are accepted from the live list (pro models
   would burn the shared free budget). */
let _proxyLive=null, _proxyLiveAt=0;
async function proxyModelAllowed(model, DB){
  if(!model) return false;
  if(PROXY_MODELS.has(model)) return true;
  if(String(model).indexOf('pro')>=0) return false;
  if(!/^gemini-[0-9]+(\.[0-9]+)?-(flash)(-lite)?$/.test(String(model))) return false;
  try{
    const now=Date.now();
    if(!_proxyLive || (now-_proxyLiveAt)>600000){
      const v=await getConfig(DB,'model_live');
      _proxyLive={}; (JSON.parse(v||'[]')||[]).forEach(function(id){ _proxyLive[id]=1; });
      _proxyLiveAt=now;
    }
    return !!_proxyLive[model];
  }catch(_){ return false; }
}
async function handleGeminiProxy(request, env, DB){
  if(request.method!=='POST') return err('method not allowed',405,env);
  const KEY = env && env.GEMINI_KEY;
  if(!KEY) return json({error:'GEMINI_KEY not set on this Worker.'},500,env);
  let body; try{ body = await request.json(); }catch(_){ return json({error:'Bad JSON'},400,env); }
  const model = body && body.model;
  if(!model || !(await proxyModelAllowed(model, DB))) return json({error:'Model not allowed',code:'BAD_MODEL'},400,env);
  const cap = parseInt((env && env.DAILY_CAP)||'',10) || 3580;
  const today = nowIso().slice(0,10);
  let newCount=0, capActive=false;
  try{
    await DB.prepare('INSERT INTO kh_shared_api_usage(date,count) VALUES(?,1) ON CONFLICT(date) DO UPDATE SET count=count+1').bind(today).run();
    const r = await DB.prepare('SELECT count FROM kh_shared_api_usage WHERE date=?').bind(today).first();
    newCount = (r&&r.count)||0; capActive=true;
  }catch(_){ /* counter unavailable — serve without the cap */ }
  if(capActive && newCount>cap){
    return json({error:'Shared key tapped out today ('+newCount+'/'+cap+'). Resets midnight UTC, or add your own Gemini key.',code:'CAP_REACHED',count:newCount,cap:cap},429,env);
  }
  const up = await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':streamGenerateContent?alt=sse&key='+KEY,{
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify((body&&body.payload)||{}),
  });
  return new Response(up.body, {status:up.status, headers:Object.assign({}, cors(env), {'Content-Type':'text/event-stream','x-kh-count':String(newCount),'x-kh-cap':String(cap)})});
}

/* ── Cloudflare free-tier budget guard ───────────────────────────────────────
   The free plan caps Workers at 100,000 requests/day and D1 at 100,000 ROW
   WRITES/day (both reset 00:00 UTC; D1 also: 5M reads/day, 5GB storage). To make
   it *impossible* to blow past either, every request is counted and, near the
   cap, non-admin traffic is shed (reads stay up while only the write budget is
   gone). We must not write the counter on every request — that would itself burn
   the 100k write budget — so each isolate counts locally and flushes the
   accumulated delta to kh_daily in batches (~1 write per 40 requests, or every
   20s), reading back the global total. Writes are estimated at 2 row-writes per
   mutating request (the insert/update + an amortised cap-trim/GC delete). */
let _budget = { date:'', estN:0, pendN:0, estW:0, pendW:0, lastFlush:0 };
/* Latest share of the daily free-tier budget used (0..1), stamped onto every
   response as X-KH-Load so clients can self-throttle their background polling
   before anyone hits the hard cap (closed-loop capacity control). */
let _loadFrac = 0;
const REQ_HARD_CAP   = 99000;   // Workers free: 100k requests/day — error at 99k, resets 00:00 UTC
const WRITE_HARD_CAP = 90000;   // D1 free: 100k row-writes/day — separate safety (estW counts 2/write)
async function dailyUsed(DB, isWrite){
  const today = nowIso().slice(0,10);
  const now = Date.now();
  if(_budget.date!==today) _budget = { date:today, estN:0, pendN:0, estW:0, pendW:0, lastFlush:0 };
  _budget.estN++; _budget.pendN++;
  if(isWrite){ _budget.estW += 2; _budget.pendW += 2; }
  const due = _budget.pendN>=40 || _budget.pendW>=40 || (now-_budget.lastFlush)>20000;
  if(due){
    const an=_budget.pendN, aw=_budget.pendW; _budget.pendN=0; _budget.pendW=0; _budget.lastFlush=now;
    try{
      await DB.prepare('INSERT INTO kh_daily(date,n,w) VALUES(?,?,?) ON CONFLICT(date) DO UPDATE SET n=n+?, w=w+?').bind(today,an,aw,an,aw).run();
      const r = await DB.prepare('SELECT n,w FROM kh_daily WHERE date=?').bind(today).first();
      if(r){ if(typeof r.n==='number') _budget.estN=r.n; if(typeof r.w==='number') _budget.estW=r.w; }
    }catch(_){ /* counter unavailable — fall back to the local per-isolate estimate */ }
  }
  return { n:_budget.estN, w:_budget.estW };
}

/* ── Autonomous AI moderator (lets KindleHub police itself for weeks) ─────────
   A Cloudflare Cron trigger fires scheduled() periodically. When AUTO_MOD is on
   and GEMINI_KEY is set, it reads recent un-actioned [USERNAME] reports from
   kh_feedback and, using the AI verdict the client already recorded (or asking
   Gemini itself), applies the decision SERVER-SIDE — so reports get actioned even
   when no admin is online. This is what lets the AI "maintain KindleHub" for up
   to a month: bans, warnings, dismissals and human-escalation all happen here.

   Env on the Worker:
     GEMINI_KEY        (required) — same key as the shared-AI proxy
     AUTO_MOD=1        (required) — opt-in master switch (omit/0 = disabled)
     ADMIN_USERNAMES   (optional) — comma list never auto-actioned
     MOD_MODEL         (optional) — Gemini model (default gemini-2.5-flash-lite)
     MOD_MAX           (optional) — max reports per run (default 10)
   wrangler.toml:  [triggers]\n  crons = ["0 * * * *"]   # hourly */
async function geminiOnce(env, prompt){
  const KEY = env && env.GEMINI_KEY; if(!KEY) return '';
  const model = (env && env.MOD_MODEL) || 'gemini-2.5-flash-lite';
  try{
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent?key='+KEY,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0.1,maxOutputTokens:120}})
    });
    if(!r.ok) return '';
    const j = await r.json();
    const parts = ((((j.candidates||[])[0]||{}).content)||{}).parts || [];
    return parts.map(p=>p.text||'').join('').trim();
  }catch(_){ return ''; }
}
function modPrompt(reportText, name){
  return 'You are the content-moderation assistant for KindleHub, a friendly e-reader chat app whose users include minors. '
    +'A user REPORTED another user\'s USERNAME (full report below). Decide the action and reply on ONE line in EXACTLY this format:\n'
    +'AI: <BAN|WARN|ESCALATE|IGNORE|NEEDINFO> — <one short reason>\n\n'
    +'BAN = clear slur / sexual / hateful / impersonation username. WARN = borderline. ESCALATE = a human admin should judge. '
    +'IGNORE = no violation or likely false report. NEEDINFO = too vague. Be strict on slurs and sexual content; lenient on ordinary names.\n\n'
    +'REPORTED USERNAME: "'+String(name||'').slice(0,80)+'"\nFULL REPORT:\n'+String(reportText||'').slice(0,1200);
}
async function markFeedback(DB, id, status, note){
  try{
    if(note) await DB.prepare('UPDATE kh_feedback SET status=?, status_at=?, text=text||? WHERE id=?').bind(status, nowIso(), '\n[auto-mod] '+note, id).run();
    else await DB.prepare('UPDATE kh_feedback SET status=?, status_at=? WHERE id=?').bind(status, nowIso(), id).run();
  }catch(_){}
}
async function runAutoModeration(DB, env){
  let rows=[];
  try{
    const res = await DB.prepare("SELECT id,text FROM kh_feedback WHERE text LIKE '%[USERNAME]%' AND text NOT LIKE '%[auto-mod]%' AND (status IS NULL OR status='' OR status='open') ORDER BY date DESC LIMIT ?")
      .bind(parseInt((env&&env.MOD_MAX)||'',10)||10).all();
    rows = (res && res.results) || [];
  }catch(_){ return; }
  const admins = String((env&&env.ADMIN_USERNAMES)||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
  for(const row of rows){
    try{
      const text = String(row.text||'');
      const name = ((text.match(/Username:\s*"([^"]+)"/)||[])[1]||'').trim();
      if(!name){ await markFeedback(DB, row.id, 'open', 'no username parsed'); continue; }
      if(admins.indexOf(name.toLowerCase())>=0){ await markFeedback(DB, row.id, 'open', 'subject is an admin — skipped'); continue; }
      /* SECURITY: NEVER trust a client-embedded "AI: BAN" verdict — anyone can
         submit a report whose text contains that string and would otherwise get
         a named user auto-banned. Always re-derive the verdict SERVER-SIDE from
         Gemini, with any embedded "AI: <verdict>" line STRIPPED first so it can't
         bias the model. If Gemini is unavailable, leave it for a human — never
         auto-action on a report we couldn't independently judge. */
      const cleanText = text.replace(/AI:\s*(?:BAN|WARN|ESCALATE|IGNORE|NEEDINFO)\b[^\n]*/ig, '');
      const out = await geminiOnce(env, modPrompt(cleanText, name));
      let verdict = (String(out).match(/(?:BAN|WARN|ESCALATE|IGNORE|NEEDINFO)\b[^\n]*/i)||[])[0] || '';
      if(!verdict){ await markFeedback(DB, row.id, 'open', 'no server AI verdict — needs human review'); continue; }
      const action = ((verdict.match(/(BAN|WARN|ESCALATE|IGNORE|NEEDINFO)/i)||[])[1]||'ESCALATE').toUpperCase();
      const reason = ((verdict.split('—')[1] || verdict.replace(/^[^-]*-/,'') || 'community guidelines').trim()).slice(0,160);
      if(action==='BAN'){
        await DB.prepare('INSERT INTO kh_banned_usernames(name,reason,created_at) VALUES(?,?,?) ON CONFLICT(name) DO NOTHING').bind(name.toLowerCase(), 'auto-mod: '+reason, nowIso()).run();
        await markFeedback(DB, row.id, 'done', 'auto-banned: '+reason);
      } else if(action==='WARN'){
        const wtext = '[[KH_WARN]]WARNING from the moderators\n\n'+reason+'\n\nThis is a warning, not a ban — repeated issues may lead to a ban.';
        await DB.prepare('INSERT INTO kh_announcements(text,active,targets,created_at) VALUES(?,1,?,?)').bind(wtext, JSON.stringify([name]), nowIso()).run();
        await markFeedback(DB, row.id, 'done', 'auto-warned: '+reason);
      } else if(action==='IGNORE'){
        await markFeedback(DB, row.id, 'ignored', 'no violation: '+reason);
      } else {
        await markFeedback(DB, row.id, 'open', 'needs human review: '+reason);
      }
    }catch(_){ /* skip this report, try the rest */ }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   AUTO-MAINTENANCE — a daily cron that finds bugs KindleHub users actually hit
   (from kh_errors) and, using a 3-model Gemini pipeline, drafts + verifies +
   auto-publishes small defensive fixes to every client. Fully opt-in.

   Pipeline (models overridable via env): DETECT (gemini-3.1-flash-lite) →
   FIX (gemini-3.5-flash) → CONFIRM (gemini-2.5-flash). A server-side Kindle-Silk
   safety gate sits between FIX and CONFIRM: anything it can't prove safe is
   STAGED (needs_review) instead of published. Verified fixes are appended to a
   reserved [[KH_FIX]] broadcast record that every client applies (deferred +
   try/caught so a fix can never brick boot; respects the per-device opt-out).

   Persistence: every distinct bug (by signature) is a row in kh_maint, so when
   the Gemini free quota runs out mid-run the rest is marked 'deferred' and the
   NEXT day's tick resumes exactly where it left off. "Remembers for tomorrow."

   Config: set the key + on/off in the app (Auto-fix tab) OR via env vars
   MAINT_ON=1 + MAINT_KEY (a Worker env var always overrides the in-app config).
   Optional: MAINT_DETECT_MODEL / MAINT_FIX_MODEL / MAINT_CONFIRM_MODEL, MAINT_MAX
   (bugs per tick, default 3 — casual), MAINT_STAGE_ONLY=1 (never auto-publish).
   SCHEDULE: the scheduled() hook self-limits maintenance to ONCE PER UTC DAY, so
   ANY cron trigger that fires at least daily works — including the same hourly
   trigger auto-moderation uses. No separate/dedicated schedule to configure.
   ═════════════════════════════════════════════════════════════════════════ */
const MAINT_FIX_TAG='[[KH_FIX]]';
function maintSig(text){
  let s=String(text||'');
  s=s.replace(/^User:[^\n]*\n/,'').replace(/─{3,}[\s\S]*$/,'');
  s=s.slice(0,300).replace(/\d+/g,'#').replace(/\s+/g,' ').trim().toLowerCase();
  let h=5381; for(let i=0;i<s.length;i++){ h=((h*33)^s.charCodeAt(i))>>>0; }
  return 'm'+h.toString(36);
}
function maintParseJson(t){ try{ const m=String(t||'').match(/\{[\s\S]*\}/); return m?JSON.parse(m[0]):null; }catch(_){ return null; } }
async function geminiModel(env, key, model, prompt, maxTokens, temp){
  if(!key) return {text:'',quota:false};
  try{
    const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent?key='+key,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:(temp==null?0.2:temp),maxOutputTokens:maxTokens||512}})
    });
    if(r.status===429) return {text:'',quota:true};
    if(!r.ok){ let t=''; try{ t=await r.text(); }catch(_){} return {text:'',quota:/RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(t)}; }
    const j=await r.json();
    const parts=((((j.candidates||[])[0]||{}).content)||{}).parts||[];
    return {text: parts.map(p=>p.text||'').join('').trim(), quota:false};
  }catch(_){ return {text:'',quota:false}; }
}
/* Server-side Kindle-Silk safety + auth-deny gate — mirrors the client's
   _khSiteScanSilk + _khSiteBlockRE so a fix can't ship Silk-incompatible or
   credential-touching code. Returns '' when safe, else a reason. */
function maintUnsafe(code, kind){
  const c=String(code||'');
  if(!c.trim()) return 'empty';
  if(c.length>8000) return 'too large';
  if(kind==='css'){ if(/@import\b|expression\s*\(|javascript:/i.test(c)) return 'unsafe CSS'; return ''; }
  const P=[[/[)\]\w$]\?\?=/,'??='],[/[)\]\w$]\?\?(?!=)/,'??'],[/[)\]\w$]\?\.\s*[A-Za-z_$([]/,'?.'],[/(?:^|[^A-Za-z0-9_$])catch\s*\{/,'parameterless catch'],[/[)\]\w$]\s*\|\|=/,'||='],[/[)\]\w$]\s*&&=/,'&&='],[/[^A-Za-z_$.]\d[\d]*_[\d_]*\b/,'numeric separators'],[/\(\?<[=!]/,'regex lookbehind'],[/\(\?<[A-Za-z_]/,'regex named group'],[/\\[pP]\{/,'regex \\p{}'],[/[^A-Za-z0-9_$.]\d[\d_]*n(?![A-Za-z0-9_$])/,'BigInt']];
  for(const p of P){ if(p[0].test(c)) return 'Kindle-incompatible: '+p[1]; }
  if(/_ADMIN_HASHES|ADMIN_HASHES|_adminToken|X-KH-Admin|x-kh-admin|\bauthToken\b|authRegister|authLogin|_offlineCred|kh_offline_cred|_encryptState|_decryptState|_msgEncrypt|_msgDecrypt|SUPABASE_ANON_KEY|service_role|document\.cookie|\bkh_users\b/.test(c)) return 'touches auth/crypto internals';
  try{ new Function(c); }catch(e){ return 'syntax error: '+((e&&e.message)||e); }
  return '';
}
async function readMaintFixes(DB){
  try{
    const res=await DB.prepare("SELECT text FROM kh_announcements WHERE active=1 AND text LIKE ? ORDER BY id DESC LIMIT 1").bind(MAINT_FIX_TAG+'%').all();
    const row=res&&res.results&&res.results[0];
    if(!row) return [];
    const arr=JSON.parse(String(row.text).slice(MAINT_FIX_TAG.length));
    return Array.isArray(arr)?arr:[];
  }catch(_){ return []; }
}
async function writeMaintFixes(DB, arr){
  try{
    await DB.prepare("DELETE FROM kh_announcements WHERE text LIKE ?").bind(MAINT_FIX_TAG+'%').run();
    await DB.prepare("INSERT INTO kh_announcements(text,active,targets,created_at) VALUES(?,1,'[]',?)").bind(MAINT_FIX_TAG+JSON.stringify((arr||[]).slice(-40)), nowIso()).run();
  }catch(_){}
}
function maintDetectPrompt(err){
  return 'You are the automatic bug-triage step for KindleHub, a single-file JavaScript e-reader web app that must run on OLD Kindle Silk WebKit. Below is a captured runtime error. Decide if it is a REAL, fixable CLIENT-side bug that a small DEFENSIVE JavaScript or CSS patch could safely guard against (missing null-check, undefined property access, bad DOM lookup) — NOT a network/backend/third-party/CORS issue. Reply ONLY strict JSON: {"fixable": true|false, "cause":"<one short sentence>", "approach":"<how a tiny defensive patch would guard it>"}.\n\nERROR:\n'+String(err||'').slice(0,1500);
}
/* Compact architecture briefing so the fix model knows the app it's patching
   (state object, persistence, time source, global helpers, theme vars). Named
   in words so it can't trip a raw-text Silk-operator scan. */
const KH_MAINT_CONTEXT='KindleHub internals you can rely on: global state object S (persisted gzip-packed to localStorage key kindlehub_v5); all time via NOW() not new Date(); views built by BUILDERS.<id>() and shown with showView(id); global helpers el(tag,attrs,kids), txt(tag,text,attrs), toast(msg), $ (getElementById), save(); theme CSS variables --accent --fg --bg --card --muted --highlight; button classes .btn/.btn.primary/.btn.small. Guard against missing globals with typeof checks before use.';
function maintFixPrompt(err, dv){
  return 'Write a SMALL, SELF-CONTAINED JavaScript patch that safely GUARDS against this KindleHub bug at runtime. It runs once on every client with full page access. Root cause: '+String((dv&&dv.cause)||'')+'. Approach: '+String((dv&&dv.approach)||'')+'.\n'+KH_MAINT_CONTEXT+'\nHARD RULES: OLD Kindle Silk WebKit, ES5/ES2015 ONLY — do NOT use optional chaining, nullish coalescing, logical-assignment operators, numeric separators, BigInt, or modern regex (lookbehind, named groups, unicode-property, or s/y/d/u flags); give every catch an error parameter. Wrap everything in try/catch. NEVER touch login, auth, encryption, credential storage, or the network. Prefer defensively wrapping the failing function (typeof checks, guards). Keep it under ~40 lines. Output ONLY the raw JavaScript — no markdown, no comments, no explanation.\n\nERROR:\n'+String(err||'').slice(0,1200);
}
function maintConfirmPrompt(err, code, dv){
  return 'You are the FINAL safety check for an auto-published KindleHub fix. Does the JavaScript patch below (a) plausibly fix or guard the described bug, AND (b) look safe + minimal (no auth/network/storage tampering, no infinite loops, old-Kindle-safe, cannot make things worse)? Reply ONLY strict JSON: {"ok": true|false, "reason":"<short>"}.\n\nBUG: '+String((dv&&dv.cause)||err).slice(0,400)+'\n\nPATCH:\n'+String(code||'').slice(0,2000);
}
/* Config resolution: a Worker env var ALWAYS wins (the secure path); otherwise
   fall back to the admin-settable kh_config row (set from the app UI). */
async function getConfig(DB, key){ try{ const r=await DB.prepare("SELECT v FROM kh_config WHERE k=?").bind(key).first(); return r?String(r.v||''):''; }catch(_){ return ''; } }
async function setConfig(DB, key, val){ try{ await DB.prepare("INSERT INTO kh_config(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(key,String(val==null?'':val)).run(); }catch(_){} }
async function maintKey(env, DB){ if(env&&env.MAINT_KEY) return env.MAINT_KEY; const v=await getConfig(DB,'maint_key'); return v?await unwrapCell(v, env):''; }
async function maintEnabled(env, DB){ if(env&&env.MAINT_ON&&String(env.MAINT_ON)!=='0'&&String(env.MAINT_ON).toLowerCase()!=='false') return true; return (await getConfig(DB,'maint_on'))==='1'; }
async function maintStageOnly(env, DB){
  /* SAFE DEFAULT = STAGE ONLY. Auto-publishing AI-generated JavaScript to every
     client is high-risk (the Silk safety filter blocks syntax, not exfiltration/
     network/DOM abuse comprehensively), so staging (needs_review) is the default
     and auto-publish must be an EXPLICIT opt-out: env MAINT_STAGE_ONLY=0 or the
     in-app auto-publish toggle set to off. Unset = staged. */
  if(env&&String(env.MAINT_STAGE_ONLY)==='1') return true;
  if(env&&String(env.MAINT_STAGE_ONLY)==='0') return false;
  return (await getConfig(DB,'maint_stage_only'))!=='0';
}
async function runAutoMaintenance(DB, env){
  const KEY=await maintKey(env, DB); if(!KEY) return {ran:false,reason:'no maintenance key'};
  const mDetect=(env&&env.MAINT_DETECT_MODEL)||'gemini-3.1-flash-lite';
  const mFix=(env&&env.MAINT_FIX_MODEL)||'gemini-3.5-flash';
  const mConfirm=(env&&env.MAINT_CONFIRM_MODEL)||'gemini-2.5-flash';
  const MAX=parseInt((env&&env.MAINT_MAX)||'',10)||3;
  const stageOnly=await maintStageOnly(env, DB);
  const stats={seeded:0,fixed:0,staged:0,wontfix:0,deferred:0};
  /* 1. Seed new bug signatures from the errors users actually hit. */
  try{
    const res=await DB.prepare("SELECT id,text FROM kh_errors ORDER BY date DESC LIMIT 50").all();
    for(const r of ((res&&res.results)||[])){
      const sig=maintSig(r.text);
      const ins=await DB.prepare("INSERT INTO kh_maint(sig,status,err,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(sig) DO NOTHING")
        .bind(sig,'new',String(r.text||'').slice(0,2000),nowIso(),nowIso()).run();
      if(ins&&ins.meta&&ins.meta.changes) stats.seeded++;
    }
  }catch(_){}
  /* 2. Process a small casual batch (oldest-touched new/deferred first). */
  let items=[];
  try{
    const res=await DB.prepare("SELECT sig,err FROM kh_maint WHERE status IN ('new','deferred') ORDER BY updated_at ASC LIMIT ?").bind(MAX).all();
    items=(res&&res.results)||[];
  }catch(_){ return {ran:false,reason:'query failed'}; }
  const fixes=await readMaintFixes(DB); let changed=false, quotaHit=false;
  const setRow=async(sig,status,ex)=>{ try{ await DB.prepare("UPDATE kh_maint SET status=?, detect=COALESCE(?,detect), fix_kind=COALESCE(?,fix_kind), fix_code=COALESCE(?,fix_code), confirm=COALESCE(?,confirm), attempts=attempts+1, updated_at=? WHERE sig=?")
    .bind(status,(ex&&ex.detect)||null,(ex&&ex.kind)||null,(ex&&ex.code)||null,(ex&&ex.confirm)||null,nowIso(),sig).run(); }catch(_){} };
  for(const it of items){
    const d=await geminiModel(env,KEY,mDetect,maintDetectPrompt(it.err),300,0.1);
    if(d.quota){ quotaHit=true; break; }
    const dv=maintParseJson(d.text);
    if(!dv || dv.fixable===false || dv.fixable==='false'){ await setRow(it.sig,'wont_fix',{detect:String(d.text||'').slice(0,400)}); stats.wontfix++; continue; }
    const f=await geminiModel(env,KEY,mFix,maintFixPrompt(it.err,dv),900,0.2);
    if(f.quota){ quotaHit=true; break; }
    const code=String(f.text||'').replace(/```[a-z]*\n?|```/g,'').trim();
    const kind=(/^\s*[.#@*a-zA-Z][^{;=]*\{[^}]*\}/.test(code)&&!/\bfunction\b|=>|\bvar \b|\blet \b|\bconst \b/.test(code))?'css':'js';
    const bad=maintUnsafe(code,kind);
    if(!code||bad){ await setRow(it.sig,'needs_review',{detect:String(d.text||'').slice(0,400),kind:kind,code:code.slice(0,4000),confirm:'unsafe: '+bad}); stats.staged++; continue; }
    const c=await geminiModel(env,KEY,mConfirm,maintConfirmPrompt(it.err,code,dv),200,0);
    if(c.quota){ quotaHit=true; break; }
    const cv=maintParseJson(c.text);
    const okFix=cv&&(cv.ok===true||cv.ok==='true');
    if(!okFix||stageOnly){ await setRow(it.sig,'needs_review',{detect:String(d.text||'').slice(0,400),kind:kind,code:code.slice(0,4000),confirm:String(c.text||'').slice(0,300)}); stats.staged++; continue; }
    fixes.push({id:it.sig,kind:kind,code:code,note:String((dv&&dv.cause)||'auto-fix').slice(0,120),ts:Date.now()});
    changed=true;
    await setRow(it.sig,'fixed',{detect:String(d.text||'').slice(0,400),kind:kind,code:code.slice(0,4000),confirm:String(c.text||'').slice(0,300)});
    stats.fixed++;
  }
  if(quotaHit){ try{ const r=await DB.prepare("UPDATE kh_maint SET status='deferred', updated_at=? WHERE status='new'").bind(nowIso()).run(); stats.deferred=(r&&r.meta&&r.meta.changes)||0; }catch(_){} }
  if(changed) await writeMaintFixes(DB, fixes);
  return {ran:true,quotaHit:quotaHit,stats:stats};
}

/* ══════════════════════════════════════════════════════════════════════════
   LIVE MODEL CATALOGUE — keep the app's model menus current automatically.
   Google's ListModels API is ground-truth for which Gemini models are live, so
   the daily maintenance calls it, diffs against what the app SHIPS, and
   publishes the delta in a reserved [[KH_MODELS]] broadcast the client merges
   into every model menu (new models appear, discontinued ones vanish) — no code
   deploy. Purely additive/subtractive; the shipped defaults still work if this
   record is absent. Additions are always published (low risk); removals only
   when the live list looks complete (sanity gate) so a truncated API response
   can't wrongly hide a working model.
   ═════════════════════════════════════════════════════════════════════════ */
const MODELS_TAG='[[KH_MODELS]]';
/* The Gemini ids the app currently ships (mirror the client lists so the diff
   is meaningful). Keep in rough sync with index.html's GEMINI_GROUPS /
   CHAT_GEMINI_GROUPS — drift is self-correcting for adds (client dedups) and
   only affects which removals are proposed. */
const KNOWN_GEMINI_MODELS=new Set([
  'gemini-3.1-flash-lite','gemini-3.5-flash','gemini-3.1-flash','gemini-2.5-flash',
  'gemini-2.5-flash-lite','gemini-2.0-flash','gemini-2.0-flash-lite',
  'gemini-3.1-pro','gemini-2.5-pro',
]);
/* Build a human label from an id: gemini-2.5-flash-lite -> "Gemini 2.5 Flash Lite". */
function _modelLabel(id){
  return String(id||'').split('-').map(function(w){
    if(/^\d/.test(w)) return w;                 /* keep version numbers as-is */
    return w.charAt(0).toUpperCase()+w.slice(1);
  }).join(' ');
}
/* Keep only clean, stable, chat-capable Gemini ids — drop experimental / dated
   preview / non-chat (vision/tts/embedding/image) variants that would clutter a
   menu. */
function _isCleanGeminiId(id){
  var s=String(id||'');
  if(s.indexOf('gemini-')!==0) return false;
  if(/(exp|thinking|vision|embedding|aqa|tts|image|audio|learnlm|preview|latest|native|dialog|-\d{2}-\d{2}|-\d{3,})/.test(s)) return false;
  return /^gemini-[0-9]+(\.[0-9]+)?-(flash|pro)(-lite)?$/.test(s);
}
async function readModelDelta(DB){
  try{
    const res=await DB.prepare("SELECT text FROM kh_announcements WHERE active=1 AND text LIKE ? ORDER BY id DESC LIMIT 1").bind(MODELS_TAG+'%').all();
    const row=res&&res.results&&res.results[0];
    if(!row) return null;
    return JSON.parse(String(row.text).slice(MODELS_TAG.length));
  }catch(_){ return null; }
}
async function writeModelDelta(DB, obj){
  try{
    await DB.prepare("DELETE FROM kh_announcements WHERE text LIKE ?").bind(MODELS_TAG+'%').run();
    await DB.prepare("INSERT INTO kh_announcements(text,active,targets,created_at) VALUES(?,1,'[]',?)").bind(MODELS_TAG+JSON.stringify(obj), nowIso()).run();
  }catch(_){}
}
async function runModelRefresh(DB, env){
  const KEY=await maintKey(env, DB); if(!KEY) return {ran:false,reason:'no key'};
  let live=[];
  try{
    const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key='+KEY);
    if(!r.ok) return {ran:false,reason:'listmodels '+r.status};
    const j=await r.json();
    const seen={};
    for(const m of (j.models||[])){
      const id=String(m.name||'').replace(/^models\//,'');
      const methods=m.supportedGenerationMethods||m.supported_generation_methods||[];
      if(methods.indexOf&&methods.indexOf('generateContent')<0) continue;
      if(!_isCleanGeminiId(id)) continue;
      if(seen[id]) continue; seen[id]=1;
      live.push(id);
    }
  }catch(_){ return {ran:false,reason:'fetch failed'}; }
  if(!live.length) return {ran:false,reason:'no models returned'};
  const liveSet={}; live.forEach(function(id){liveSet[id]=1;});
  /* Additions: live models the app doesn't ship. */
  const addGemini=[];
  for(const id of live){ if(!KNOWN_GEMINI_MODELS.has(id)) addGemini.push([id,_modelLabel(id)]); }
  /* Removals: shipped models Google no longer lists — only when the response
     looks complete (>=6 models) so a partial list can't wrongly hide models. */
  const removeGemini=[];
  if(live.length>=6){ KNOWN_GEMINI_MODELS.forEach(function(id){ if(!liveSet[id]) removeGemini.push(id); }); }
  const delta={addGemini:addGemini,removeGemini:removeGemini,live:live,at:nowIso()};
  /* Persist a plain live-id list for the shared proxy allow-list refresh. */
  try{ await setConfig(DB,'model_live',JSON.stringify(live)); }catch(_){}
  /* Only (re)publish the broadcast when the delta actually changed. */
  const prev=await readModelDelta(DB);
  const sig=function(o){ return o?JSON.stringify([(o.addGemini||[]).map(function(x){return x[0];}).sort(),(o.removeGemini||[]).slice().sort()]):''; };
  if(sig(prev)!==sig(delta)){ await writeModelDelta(DB, delta); }
  return {ran:true,add:addGemini.length,remove:removeGemini.length,live:live.length};
}

/* ── Per-IP rate limit (Cache API — no KV, free, per-colo) ───────────────────
   Stops ONE source from flooding the Worker and tripping the shared daily budget
   for everyone. Two windows: a short burst limit + a generous daily limit (well
   above any real household, well below the 90k global cap). Distributed botnets
   are still caught by the global budget guard + (recommended) Cloudflare Bot
   Fight Mode. Admin bypasses. Cache failure never blocks legit traffic. */
async function rlHit(ip, limit, windowSec, tag){
  try{
    const key='https://rl.kh.internal/'+tag+'/'+encodeURIComponent(ip||'0')+'/'+Math.floor(Date.now()/(windowSec*1000));
    const cache=caches.default;
    const hit=await cache.match(key);
    const n=(hit?(parseInt(await hit.text(),10)||0):0)+1;
    await cache.put(key,new Response(String(n),{headers:{'Cache-Control':'max-age='+windowSec}}));
    return n>limit;
  }catch(_){ return false; }
}

export default {
  async scheduled(event, env, ctx){
    try{
      const DB = env && env.DB; if(!DB) return;
      await ensureSchema(DB);
      /* Housekeeping (ALWAYS — no opt-in needed): prune resolved feedback older
         than 7 days so done/ignored bug reports + suggestions auto-delete from the
         cloud. COALESCE(status_at, date) also clears the legacy backlog. */
      try{
        const cut = new Date(Date.now()-7*86400000).toISOString();
        await DB.prepare("DELETE FROM kh_feedback WHERE status IN ('done','ignored') AND COALESCE(status_at, date) < ?").bind(cut).run();
      }catch(_){}
      /* AI moderation (opt-in via AUTO_MOD + GEMINI_KEY). */
      const on = env && env.AUTO_MOD && String(env.AUTO_MOD)!=='0' && String(env.AUTO_MOD).toLowerCase()!=='false';
      if(on && env.GEMINI_KEY) await runAutoModeration(DB, env);
      /* Auto-maintenance (opt-in via MAINT_ON+MAINT_KEY env, OR the in-app config).
         Self-limits to ONCE PER UTC DAY via a kh_config marker, so it's "daily"
         no matter how often the cron fires — reuse ANY existing trigger (even the
         hourly auto-moderation one); no need to configure a separate schedule.
         The day is stamped BEFORE the run so overlapping ticks can't double-fire.
         (The manual "Run now" button bypasses this gate.) */
      if(await maintEnabled(env, DB) && await maintKey(env, DB)){
        const _today=nowIso().slice(0,10);
        if((await getConfig(DB,'maint_last_day'))!==_today){
          await setConfig(DB, 'maint_last_day', _today);
          await runAutoMaintenance(DB, env);
          /* Once a day, also refresh the live model catalogue so menus keep up
             with new/discontinued Gemini models. Cheap (one ListModels call);
             never blocks the bug pipeline. */
          try{ await runModelRefresh(DB, env); }catch(_){}
        }
      }
    }catch(_){ /* never throw out of a cron tick */ }
  },
  async fetch(request, env){
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors(env)});
    const DB = env && env.DB;
    if(!DB) return err('DB binding missing — see setup step 3', 500, env);
    await ensureSchema(DB);
    await _syncAdminSecret(env);/* pick up ADMIN_SECRET rotation before any isAdmin() */
    const url = new URL(request.url);
    if(url.pathname==='/' || url.pathname==='') return json({ok:true,service:'kindlehub-api'},200,env);

    /* Auto-maintenance admin endpoints (admin token required). /maint/run kicks a
       tick on demand (same work the daily cron does); /maint/status returns the
       queue counts + recent rows for the admin monitor UI. */
    if(url.pathname==='/maint/run' || url.pathname==='/maint/status' || url.pathname==='/maint/config'){
      if(!(await isAdmin(request.headers.get('x-kh-admin')||''))) return json({error:'admin only'},403,env);
      /* Set the maintenance key / on-off from the app (stored envelope-wrapped
         when KH_PEPPER is set). A Worker env var, if present, still overrides. */
      if(url.pathname==='/maint/config'){
        let body={}; try{ body=await request.json(); }catch(_){}
        if(typeof body.key==='string' && body.key.trim()){ await setConfig(DB, 'maint_key', await wrapCell(body.key.trim(), env)); }
        if(body.clearKey===true){ await setConfig(DB, 'maint_key', ''); }
        if(typeof body.on!=='undefined'){ await setConfig(DB, 'maint_on', body.on ? '1' : '0'); }
        if(typeof body.stageOnly!=='undefined'){ await setConfig(DB, 'maint_stage_only', body.stageOnly ? '1' : '0'); }
        return json({ok:true, keyConfigured: !!(await maintKey(env, DB)), enabled: await maintEnabled(env, DB)},200,env);
      }
      if(url.pathname==='/maint/run'){
        if(!(await maintKey(env, DB))) return json({error:'No maintenance key set — add your Gemini key in the Auto-fix tab (or set MAINT_KEY on the Worker).'},400,env);
        const r=await runAutoMaintenance(DB, env);
        /* Also refresh the model catalogue on a manual run, so "Run now" both
           fixes bugs AND updates the model menus. */
        let models=null; try{ models=await runModelRefresh(DB, env); }catch(_){}
        return json({ok:true,result:r,models:models},200,env);
      }
      let counts={}, recent=[];
      try{
        const cr=await DB.prepare("SELECT status, COUNT(*) n FROM kh_maint GROUP BY status").all();
        for(const row of ((cr&&cr.results)||[])) counts[row.status]=row.n;
        const rr=await DB.prepare("SELECT sig,status,fix_kind,detect,confirm,updated_at FROM kh_maint ORDER BY updated_at DESC LIMIT 30").all();
        recent=(rr&&rr.results)||[];
      }catch(_){}
      let fixCount=0; try{ fixCount=(await readMaintFixes(DB)).length; }catch(_){}
      let modelDelta=null; try{ const md=await readModelDelta(DB); if(md) modelDelta={added:(md.addGemini||[]).length,removed:(md.removeGemini||[]).length,live:(md.live||[]).length,at:md.at||''}; }catch(_){}
      const keyOn=!!(await maintKey(env, DB)), enOn=await maintEnabled(env, DB);
      return json({ok:true,counts:counts,recent:recent,liveFixes:fixCount,models:modelDelta,keyConfigured:keyOn,enabled:(enOn&&keyOn),envKey:!!(env&&env.MAINT_KEY)},200,env);
    }

    /* Per-IP rate limit — one abuser can't burn the shared daily budget for
       everyone. Tunable via env RL_BURST (per 10s) / RL_DAY (per day); admin
       bypasses (checked only when a limit is hit, so no hashing on every req).
       RL_DAY default 4000: a real heavy user does ~2–3k req/day, while the old
       20000 default let FIVE IPs (or one stuck retry-loop client) burn the
       whole 100k daily budget and trip read-only for everyone. */
    const _ip=request.headers.get('cf-connecting-ip')||'0';
    const _overBurst=await rlHit(_ip, (parseInt((env&&env.RL_BURST)||'',10)||60), 10, 'b');
    const _overDay  =await rlHit(_ip, (parseInt((env&&env.RL_DAY)||'',10)||4000), 86400, 'd');
    if(_overBurst || _overDay){
      const adminOk=await isAdmin(request.headers.get('x-kh-admin')||'');
      if(!adminOk) return json({error:'rate-limit',code:'CF_IP',message:'Too many requests from your connection — please slow down for a moment.'},429,env);
    }

    /* Budget guard — shed non-admin load before we can hit a Cloudflare limit.
       Health check above is always allowed so uptime monitors keep working. */
    const _isWrite = request.method!=='GET' && request.method!=='HEAD';
    const _usage = await dailyUsed(DB, _isWrite);
    /* Publish the higher of the request/write utilisation so clients back off. */
    _loadFrac = Math.max(_usage.n/REQ_HARD_CAP, _usage.w/WRITE_HARD_CAP);
    /* Over a daily free-tier ceiling → just error the cloud request (503),
       non-admin only (admin token bypasses; resets 00:00 UTC). No read-only
       degrade band — a request past the limit simply fails. */
    if(_usage.n>REQ_HARD_CAP || (_usage.w>WRITE_HARD_CAP && _isWrite)){
      const adminOk = await isAdmin(request.headers.get('x-kh-admin')||'');
      if(!adminOk){
        if(_usage.n>REQ_HARD_CAP)
          return json({error:'daily-limit',code:'CF_DAILY',message:'KindleHub reached its daily free-tier request limit. Service resumes automatically at midnight UTC.'},503,env);
        return json({error:'write-limit',code:'CF_WRITE',message:'KindleHub reached its daily free-tier write limit. Service resumes automatically at midnight UTC.'},503,env);
      }
    }

    /* Shared-key AI proxy — ports the kh-gemini-proxy Supabase Edge Function onto
       this Worker so the whole backend is Cloudflare. Holds GEMINI_KEY in env. */
    if(url.pathname==='/functions/v1/kh-gemini-proxy'){
      try{ return await handleGeminiProxy(request, env, DB); }
      catch(e){ return json({error:String((e&&e.message)||e).slice(0,160)},500,env); }
    }

    const m = url.pathname.match(/^\/rest\/v1\/(rpc\/)?([A-Za-z0-9_]+)\/?$/);
    if(!m) return err('not found: '+url.pathname, 404, env);
    const isRpc = !!m[1];
    const name = m[2];

    try{
      if(isRpc){
        if(request.method!=='POST') return err('rpc requires POST',405,env);
        let body={}; try{ body = await request.json(); }catch(_){ body={}; }
        return await handleRpc(name, body, DB, env, request);
      }
      if(!COLUMNS[name]) return err('unknown table: '+name, 404, env);
      switch(request.method){
        case 'GET':    return await handleGet(name, url, request, env, DB, false);
        case 'HEAD':   return await handleGet(name, url, request, env, DB, true);
        case 'POST':   return await handlePost(name, url, request, env, DB);
        case 'PATCH':  return await handlePatch(name, url, request, env, DB);
        case 'DELETE': return await handleDelete(name, url, request, env, DB);
        default:       return err('method not allowed',405,env);
      }
    }catch(e){
      return err(String((e&&e.message)||e).slice(0,200), 500, env);
    }
  },
};

/* Named exports for the test harness only — Cloudflare Workers use ONLY the
   default export as the handler, so these are ignored at deploy time. */
export { runAutoMaintenance, maintUnsafe, maintSig, maintParseJson, readMaintFixes, writeMaintFixes, ensureSchema, setConfig, getConfig, maintKey, maintEnabled, runModelRefresh, readModelDelta, writeModelDelta, proxyModelAllowed, _isCleanGeminiId, _modelLabel, KNOWN_GEMINI_MODELS };
