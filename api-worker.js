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
const UPDATE_OK = new Set(['kh_users','kh_groups','kh_feedback','kh_presence']); // open update
const SECRET_UPDATE = new Set(['kh_messages']);          // owner_secret-gated update
const SECRET_DELETE = new Set(['kh_messages','kh_mail']); // owner_secret-gated delete

function cors(env){
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOW_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer, x-kh-secret, x-kh-admin, range, range-unit, accept',
    'Access-Control-Expose-Headers': 'Content-Range, x-kh-count, x-kh-cap',  // _sbCount total + shared-AI cap headers
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

const QUOTE = id => '"'+String(id).replace(/"/g,'')+'"';
function nowIso(){ return new Date().toISOString(); }

/* ── type marshaling ─────────────────────────────────────────────────────── */
function rowOut(table, row){
  if(!row) return row;
  const jc = JSON_COLS[table]||[], bc = BOOL_COLS[table]||[];
  const o = {};
  for(const k in row){
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
async function applyCaps(DB, table, row){
  try{
    if(table==='kh_messages' && row && row.group_code){
      await DB.prepare('DELETE FROM kh_messages WHERE group_code=? AND id NOT IN (SELECT id FROM kh_messages WHERE group_code=? ORDER BY ts DESC LIMIT 30)').bind(row.group_code,row.group_code).run();
    } else if(table==='kh_mail' && row && row.to_user){
      await DB.prepare('DELETE FROM kh_mail WHERE to_user=? AND id NOT IN (SELECT id FROM kh_mail WHERE to_user=? ORDER BY ts DESC LIMIT 60)').bind(row.to_user,row.to_user).run();
    } else if(table==='kh_scores' && row && row.game){
      await DB.prepare('DELETE FROM kh_scores WHERE game=? AND id NOT IN (SELECT id FROM kh_scores WHERE game=? ORDER BY score DESC, date DESC LIMIT 100)').bind(row.game,row.game).run();
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
    if(list.indexOf(uid)>=0) list = list.filter(v=>v!==uid); else list = list.concat([uid]);
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
  const rows = (res.results||[]).map(r=>rowOut(table,r));
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
  const conflict = q.onConflict; // upsert target columns
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
    const vals = keys.map(k=>valIn(table,k,raw[k]));
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
  return json(out, 201, env);
}

async function handlePatch(table, url, request, env, DB){
  const secretGated = SECRET_UPDATE.has(table);
  if(!UPDATE_OK.has(table) && !secretGated) return err('update not allowed on '+table, 403, env);
  let patch; try{ patch = await request.json(); }catch(_){ return err('bad json',400,env); }
  const q = parseQuery(table, url.searchParams);
  let { sql:where, binds } = whereSql(table, q.filters);
  if(secretGated){
    const secret = request.headers.get('x-kh-secret')||'';
    where += (where?' AND ':' WHERE ')+'owner_secret IS NOT NULL AND owner_secret = ?';
    binds = binds.concat([secret]);
  }
  const cols = COLUMNS[table];
  const keys = Object.keys(patch).filter(k=>cols.indexOf(k)>=0);
  if(!keys.length) return err('no valid columns to update',400,env);
  const setSql = keys.map(k=>QUOTE(k)+'=?').join(',');
  const setBinds = keys.map(k=>valIn(table,k,patch[k]));
  await DB.prepare('UPDATE '+QUOTE(table)+' SET '+setSql+where).bind(...setBinds, ...binds).run();
  const prefer = (request.headers.get('prefer')||'');
  if(/return=minimal/i.test(prefer)) return new Response(null,{status:204,headers:cors(env)});
  /* representation: re-read the affected rows with the same WHERE (minus secret) */
  const r2 = whereSql(table, q.filters);
  const res = await DB.prepare('SELECT * FROM '+QUOTE(table)+r2.sql).bind(...r2.binds).all();
  return json((res.results||[]).map(x=>rowOut(table,x)), 200, env);
}

async function handleDelete(table, url, request, env, DB){
  const secretGated = SECRET_DELETE.has(table);
  if(!secretGated && table!=='kh_feedback') return err('delete not allowed on '+table, 403, env);
  const q = parseQuery(table, url.searchParams);
  let { sql:where, binds } = whereSql(table, q.filters);
  if(secretGated){
    const secret = request.headers.get('x-kh-secret')||'';
    where += (where?' AND ':' WHERE ')+'owner_secret IS NOT NULL AND owner_secret = ?';
    binds = binds.concat([secret]);
  } else if(table==='kh_feedback'){
    /* auto-prune policy: only done/ignored items resolved > 7 days ago */
    const cut = new Date(Date.now()-7*86400000).toISOString();
    where += (where?' AND ':' WHERE ')+"status IN ('done','ignored') AND status_at IS NOT NULL AND status_at < ?";
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
];
let _schemaReady = false;
async function ensureSchema(DB){
  if(_schemaReady) return;
  try{ await DB.batch(SCHEMA_DDL.map(s=>DB.prepare(s))); _schemaReady=true; return; }
  catch(_){ /* some D1 versions reject DDL inside batch() — fall back to sequential */ }
  try{ for(const s of SCHEMA_DDL){ await DB.prepare(s).run(); } _schemaReady=true; }
  catch(_){ /* leave _schemaReady=false so the next request retries */ }
}

/* ── Shared-key Gemini proxy (ported from the Supabase Edge Function) ─────────
   Same contract the client already speaks: POST {model, payload}. Holds the key
   in env.GEMINI_KEY, enforces a first-come/first-served daily cap via the same
   kh_shared_api_usage counter, and streams Gemini's SSE back. Env vars on the
   Worker: GEMINI_KEY (required), DAILY_CAP (optional, default 3580). */
const PROXY_MODELS = new Set([
  'gemini-3.1-flash-lite','gemini-2.5-flash-lite','gemini-2.5-flash',
  'gemini-3-flash','gemini-3.5-flash','gemma-4-26b-it','gemma-4-31b-it',
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

export default {
  async fetch(request, env){
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors(env)});
    const DB = env && env.DB;
    if(!DB) return err('DB binding missing — see setup step 3', 500, env);
    await ensureSchema(DB);
    const url = new URL(request.url);
    if(url.pathname==='/' || url.pathname==='') return json({ok:true,service:'kindlehub-api'},200,env);

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
