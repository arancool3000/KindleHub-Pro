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
   • MOD_HASHES   — (optional) comma-separated SHA-256 hashes of moderator codes.
     A moderator code unlocks ONLY the kh_mod_stats RPC (aggregate community
     COUNTS — never rows, user data, mail or message bodies) and nothing else.
     Grant a moderator: pick a random code, put SHA-256(code) here, give them the
     code (they paste it into Settings → Account → Moderator tools). REVOKE
     instantly by removing the hash — no code deploy. Admins are always mods.
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
  kh_announcements:['id','text','active','targets','created_at'],
  kh_presence:['user_id','display_name','last_seen'],
  kh_shared_api_usage:['date','count'],
  kh_banned_usernames:['name','reason','created_at'],
  kh_visits:['device_id','day','last_seen','ua_hint','country','city'],
  kh_rate:['bucket','win_start','n'],
};
const PK = {
  kh_users:['hash'], kh_groups:['code'], kh_messages:['id'], kh_mail:['id'],
  kh_feedback:['id'], kh_errors:['id'], kh_scores:['id'], kh_announcements:['id'],
  kh_presence:['user_id'], kh_shared_api_usage:['date'], kh_banned_usernames:['name'],
  kh_visits:['device_id','day'], kh_rate:['bucket'],
};
const JSON_COLS = { kh_messages:['reactions'], kh_announcements:['targets'], kh_feedback:['comments'] };
const BOOL_COLS = { kh_messages:['edited','important','pinned'], kh_announcements:['active'] };
const INT_COLS  = new Set(['score','votes','count','n']);
const TS_COLS   = new Set(['updated_at','ts','created_at','date','last_seen']);
/* RLS equivalents: which tables accept a direct (anon) INSERT / open UPDATE. */
const INSERT_OK = new Set(['kh_users','kh_groups','kh_messages','kh_mail','kh_feedback','kh_errors','kh_scores','kh_presence','kh_visits']);
/* Open (anon) UPDATE. kh_groups was REMOVED: the client never PATCHes a group
   (it only INSERTs on create), and an open update let anyone enumerate room
   codes then rename / re-own every room. */
const UPDATE_OK = new Set(['kh_users','kh_feedback','kh_presence']); // open update
const SECRET_UPDATE = new Set(['kh_messages']);          // owner_secret-gated update
const SECRET_DELETE = new Set(['kh_messages','kh_mail']); // owner_secret-gated delete
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
async function isAdmin(token){ return ADMIN_HASHES.indexOf(await sha256hex(token||'')) >= 0; }
/* Limited MODERATOR role. A mod token unlocks ONLY the kh_mod_stats RPC
   (aggregate counts — never rows, user data, mail or message bodies) and
   nothing else; every privileged path still checks isAdmin. Mod hashes live in
   the Worker env `MOD_HASHES` (comma-separated SHA-256 of each mod's code), so
   the admin can grant OR instantly revoke a moderator by editing one env var —
   no code deploy. Admins are implicitly mods. */
async function isMod(token, env){
  if(await isAdmin(token)) return true;
  const raw = (env && env.MOD_HASHES) || '';
  if(!raw) return false;
  const h = await sha256hex(token||'');
  return raw.split(',').map(s=>s.trim()).filter(Boolean).indexOf(h) >= 0;
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
async function handleRpc(fn, body, DB, env){
  body = body||{};
  if(fn==='kh_mod_stats'){
    /* Limited moderator dashboard: aggregate COUNTS only. Returns numbers, never
       rows — no usernames, emails, message/mail bodies or state blobs — so a
       moderator can see how the community is doing without any access to user or
       cloud data. Gated by isMod (admins included). */
    if(!await isMod(body.p_token, env)) return err('unauthorized',403,env);
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
    if(!await isAdmin(body.p_token)) return err('not authorized',403,env);
    await DB.prepare('INSERT INTO kh_banned_usernames(name,reason,created_at) VALUES(?,?,?) ON CONFLICT(name) DO NOTHING').bind(String(body.p_name||'').trim().toLowerCase(),'admin',nowIso()).run();
    return json(null,204,env);
  }
  if(fn==='kh_unban_username'){
    if(!await isAdmin(body.p_token)) return err('not authorized',403,env);
    await DB.prepare('DELETE FROM kh_banned_usernames WHERE name=?').bind(String(body.p_name||'').trim().toLowerCase()).run();
    return json(null,204,env);
  }
  if(fn==='kh_increment_shared_api'){
    const d = String(body.p_date||nowIso().slice(0,10));
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
  }

  const out=[];
  for(const raw of rows){
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
     `votes` (upvoting a suggestion). Letting non-admins edit status/status_at/
     text/author/date would let a reported user dismiss their own report
     (status='ignored' hides it from the auto-mod cron + the human queue), strip
     the [USERNAME] marker to dodge the auto-moderator, backdate status_at to
     satisfy the 7-day delete guard, or forge `author`. Verified admins (the
     x-kh-admin token the client now sends) may patch any column. */
  if(table==='kh_feedback' && !(await isAdmin(request.headers.get('x-kh-admin')||''))){
    keys = keys.filter(k=>k==='votes');
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

async function handleDelete(table, url, request, env, DB){
  const secretGated = SECRET_DELETE.has(table);
  if(!secretGated && table!=='kh_feedback') return err('delete not allowed on '+table, 403, env);
  const q = parseQuery(table, url.searchParams);
  let { sql:where, binds } = whereSql(table, q.filters);
  if(secretGated){
    const secret = request.headers.get('x-kh-secret')||'';
    if(secret.length < 16) return err('a valid owner secret is required', 403, env);
    where += (where?' AND ':' WHERE ')+'owner_secret IS NOT NULL AND owner_secret = ?';
    binds = binds.concat([secret]);
  } else if(table==='kh_feedback'){
    /* auto-prune policy: done/ignored items resolved (or, for legacy rows with no
       status_at, created) more than 7 days ago. COALESCE lets old pre-status_at
       rows age out by their creation date instead of sticking around forever. */
    const cut = new Date(Date.now()-7*86400000).toISOString();
    where += (where?' AND ':' WHERE ')+"status IN ('done','ignored') AND COALESCE(status_at, date) < ?";
    binds = binds.concat([cut]);
  }
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
  "CREATE TABLE IF NOT EXISTS kh_announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, active INTEGER DEFAULT 1, targets TEXT DEFAULT '[]', created_at TEXT)",
  "CREATE TABLE IF NOT EXISTS kh_presence (user_id TEXT PRIMARY KEY, display_name TEXT DEFAULT '', last_seen TEXT)",
  "CREATE INDEX IF NOT EXISTS kh_presence_last_seen ON kh_presence(last_seen DESC)",
  "CREATE TABLE IF NOT EXISTS kh_shared_api_usage (date TEXT PRIMARY KEY, count INTEGER DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS kh_banned_usernames (name TEXT PRIMARY KEY, reason TEXT DEFAULT '', created_at TEXT)",
  "CREATE TABLE IF NOT EXISTS kh_visits (device_id TEXT NOT NULL, day TEXT NOT NULL, last_seen TEXT, ua_hint TEXT DEFAULT '', country TEXT DEFAULT '', city TEXT DEFAULT '', PRIMARY KEY (device_id, day))",
  "CREATE TABLE IF NOT EXISTS kh_rate (bucket TEXT PRIMARY KEY, win_start TEXT, n INTEGER DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS kh_daily (date TEXT PRIMARY KEY, n INTEGER DEFAULT 0, w INTEGER DEFAULT 0)",
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
async function handleGeminiProxy(request, env, DB){
  if(request.method!=='POST') return err('method not allowed',405,env);
  const KEY = env && env.GEMINI_KEY;
  if(!KEY) return json({error:'GEMINI_KEY not set on this Worker.'},500,env);
  let body; try{ body = await request.json(); }catch(_){ return json({error:'Bad JSON'},400,env); }
  const model = body && body.model;
  if(!model || !PROXY_MODELS.has(model)) return json({error:'Model not allowed',code:'BAD_MODEL'},400,env);
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
const REQ_HARD_CAP   = 90000;   // Workers free: 100k requests/day — stop 10% short
const WRITE_HARD_CAP = 90000;   // D1 free: 100k row-writes/day — stop 10% short
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
      /* reuse the client-recorded verdict if present, else ask Gemini */
      let verdict = (text.match(/AI:\s*(?:BAN|WARN|ESCALATE|IGNORE|NEEDINFO)\b[^\n]*/i)||[])[0] || '';
      if(!verdict){ const out = await geminiOnce(env, modPrompt(text, name)); verdict = (String(out).match(/(?:BAN|WARN|ESCALATE|IGNORE|NEEDINFO)\b[^\n]*/i)||[])[0] || ''; }
      const action = ((verdict.match(/(BAN|WARN|ESCALATE|IGNORE|NEEDINFO)/i)||[])[1]||'ESCALATE').toUpperCase();
      const reason = ((verdict.split('—')[1] || verdict.replace(/^[^-]*-/,'') || 'community guidelines').trim()).slice(0,160);
      if(action==='BAN'){
        await DB.prepare('INSERT INTO kh_banned_usernames(name,reason,created_at) VALUES(?,?,?) ON CONFLICT(name) DO NOTHING').bind(name.toLowerCase(), 'auto-mod: '+reason, nowIso()).run();
        await markFeedback(DB, row.id, 'done', 'auto-banned: '+reason);
      } else if(action==='WARN'){
        const wtext = '⚠ WARNING from the moderators\n\n'+reason+'\n\nThis is a warning, not a ban — repeated issues may lead to a ban.';
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
    }catch(_){ /* never throw out of a cron tick */ }
  },
  async fetch(request, env){
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors(env)});
    const DB = env && env.DB;
    if(!DB) return err('DB binding missing — see setup step 3', 500, env);
    await ensureSchema(DB);
    const url = new URL(request.url);
    if(url.pathname==='/' || url.pathname==='') return json({ok:true,service:'kindlehub-api'},200,env);

    /* Per-IP rate limit — one abuser can't burn the shared daily budget for
       everyone. Tunable via env RL_BURST (per 10s) / RL_DAY (per day); admin
       bypasses (checked only when a limit is hit, so no hashing on every req). */
    const _ip=request.headers.get('cf-connecting-ip')||'0';
    const _overBurst=await rlHit(_ip, (parseInt((env&&env.RL_BURST)||'',10)||100), 10, 'b');
    const _overDay  =await rlHit(_ip, (parseInt((env&&env.RL_DAY)||'',10)||20000), 86400, 'd');
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
    if(_usage.n>REQ_HARD_CAP || (_usage.w>WRITE_HARD_CAP && _isWrite)){
      const adminOk = await isAdmin(request.headers.get('x-kh-admin')||'');
      if(!adminOk){
        if(_usage.n>REQ_HARD_CAP)
          return json({error:'daily-limit',code:'CF_DAILY',message:'KindleHub reached its daily free-tier request limit. Service resumes automatically at midnight UTC.'},503,env);
        return json({error:'write-limit',code:'CF_WRITE',message:'KindleHub is temporarily read-only (daily free-tier write limit). New posts resume automatically at midnight UTC.'},503,env);
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
        return await handleRpc(name, body, DB, env);
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
