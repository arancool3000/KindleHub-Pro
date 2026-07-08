# KindleHub Pro — project memory

Single-file Kindle e-reader web app. **Everything lives in `index.html`** (~53k lines:
one big `<style>`, the markup, then ~5 inline `<script>` blocks). Supporting files:
`schema.sql` (Supabase DB setup), `email-worker.js` (Cloudflare Worker for real email),
`landing.html`, `404.html`, icons.

Target device: **Kindle e-ink, old WebKit (Silk)**. Optimise for: tiny payload, few
network calls, minimal repaints (e-ink flashes on every DOM write), no reliance on
`inset`/modern CSS, big touch targets.

## How to work on it
- Edit `index.html` directly. There is no build step.
- **Syntax check** an inline script before trusting an edit:
  `LAST=$(grep -n "^</script>" index.html | sed -n 2p | cut -d: -f1); FIRST=$(grep -n "^<script>" index.html | sed -n 2p | cut -d: -f1); sed -n "$((FIRST+1)),$((LAST-1))p" index.html > /tmp/m.js && node --check /tmp/m.js`
- **Headless test** with Playwright (global install): `NODE_PATH=/opt/node22/lib/node_modules node /tmp/<test>.cjs`.
  Seed a logged-in/onboarded state via `addInitScript` setting `localStorage['kindlehub_v5']`
  (note: the app gzip-compresses saved state, so read it back via `window._KH.S`, not raw JSON.parse).
  The repeated game-launch regression lives at `/tmp/games_test.cjs` (launches all 22 data-game buttons).
- Commit when the user asks; branch is `claude/keen-tesla-n73rpc` (was wonderful-clarke). The user merges PRs (or asks me to).
  End commit messages with the session URL line.

## Architecture cheat-sheet (grep anchors)
- **State**: `let S=` (state object) persisted to `localStorage['kindlehub_v5']`, gzip-packed.
  `NOW()` = `Date.now()+S.clockOffset` — **all time display must use NOW()/clockOffset**, never raw `new Date()`.
- **Views**: builders in `const BUILDERS={ home:()=>{…}, … }`; mounted by `showView(id)` into `#mainHost`.
  Nav tabs in the `<nav>` HTML + `const NAV_TABS=[…]`. New view = add tab HTML + NAV_TABS entry + a `BUILDERS.xxx`.
- **Split screen ("2 pages in 1")**: `enterSplit(viewId)`/`exitSplit()`/`mountSecondary(id)`/`_swapSplit()`
  + the `_khOpenMultitask()` panel (the header **Recent** button opens it — no new header button, the header
  is full). `_splitOn`/`_splitSecondary` (session-only). In split, `mainHost` holds `#kh-split` → two stacked
  panes (`#kh-pane-primary-body` / `#kh-pane-secondary-body`); `showView` mounts the PRIMARY via `_viewHost()`
  and the bottom nav drives it. Safe only because inner element IDs are unique per view — NEVER allow the same
  view in both panes (navigating primary onto the secondary's view auto-swaps instead).
- **Screenshot app**: `window.khCaptureScreen(target,name)` (defined right after the reader IIFE) lazy-loads
  html2canvas (jsdelivr) on first use, renders the live DOM (default `#app`) to a PNG, and pushes
  `{name,url,at}` onto `window._khShots` — session-only, NEVER in S (data URLs are huge, same rule as book
  text). Entry points: the `_khOpenMultitask` panel's "📷 Screenshot this page" (captures the current page)
  and `BUILDERS.screenshot` (gallery + Download PNG; "Capture last page" rebuilds the previous view off-screen).
  App-mode only (captures `#app`; in KindleOS use the device screenshot). Replaced the old upload-files Gallery.
- **Admin self-check**: Settings → Account (`_renderUltra`) states plainly "✓ You ARE an admin" (creator tier)
  vs "not an admin", and calls `_checkAdmin()` so the tier resolves; re-renders on `kh-tier-changed`.
- **Free Library / reader**: `window.khOpenBookReader(meta)` + `window.khGutenSearch(q)` (defined right after the
  `el()/txt()` helpers). Search = Gutendex JSON (CORS-open); book text via gutenberg.org through the
  allorigins/corsproxy fallbacks (no CORS header on gutenberg). Full-screen `#kh-reader` overlay paginates
  cleaned text (~1700 chars/page), saves position onto the matching `S.books` entry (`gutenbergId/readerPos/
  readerPages`). **Book text is cached in-memory only — never written to S** (a novel >1 MB would blow the
  gzip'd state quota). UI entry = the "Free Library" card at the top of `BUILDERS.reading`, plus Read/Continue
  buttons in `renderBooks`.
- **Games**: each is an IIFE module (`const Hangman=(()=>{…})()`), launched via `launchGame(id)` → `_doLaunch`.
  Immersive overlay (`enterImmersive`/`exitImmersive`, `#immersiveRoot`). Some lazy-init via `_initX()`.
  `newGameGuard(activeFn,start)` wraps "New Game" buttons to confirm mid-game. New game = `case` in `_doLaunch`
  + `gc(...)` card in `BUILDERS.games` + `GAME_HELP` entry + `GAME_MAP` entry + the id in `tools/games_test.cjs`.
  `GeometryDash` (`const GeometryDash`) is a one-button auto-runner ("Stereo Madness"): fixed hand-authored
  `LEVEL` array, canvas + flat fills, ~26fps `setInterval`; level is provably beatable (verified by a pure-
  physics sim mirror — keep them in sync if you retune `G`/`JV`/`SPD`/`LEVEL`).
  **⚠ LEAK FIX — exitImmersive stops EVERY game**: `exitImmersive()` now calls `stop()` on the FULL list of
  game modules (not just the running one + a 6-module subset), each guarded `try{if(g&&g.stop)g.stop()}`. A
  game that used `setInterval`/RAF but neither set `immersiveRoot._trackStop` NOR was in the old list kept
  ticking after you left it — every launch stacked another live loop → site got slower → Silk crashed. NB:
  `CandyCrush` is `window.CandyCrush` (lazy), so it's referenced as `window.CandyCrush` in that array (a bare
  ref throws ReferenceError before first launch and would abort the whole sweep). Every game's `stop()` must be
  a safe no-op when not running (guard its own timer/RAF handle).
  **Slither** (`const Slither`) is a slither.io-style **hybrid arena**: cheap-but-smart AI (chase food, but
  look-ahead `blockedAt()` veer so bots don't ram walls/snakes; light hunt/flee) + an **online overlay** — each
  player publishes a ~1.8s beacon (pos/angle/len/sparse-path/username) as a `kh_presence` row keyed `sl_<id>`
  with the beacon JSON packed into `display_name` (NO schema/worker change; `user_id=like.sl_*` + `last_seen`
  TTL to read peers). Real online players replace AI slots (`reconcileBots`, `TARGET_OPP`) and show their REAL
  username (◆); degrades to pure-AI when offline/no backend (`_netOk`). Snakes **spawn with a pre-built body at
  length 5** (`buildBody`, no growing-from-head); **New Game** = `reset()` (clears the `.kh-sl-gameover` msg +
  restarts both timers — the old handler left the game-over text up and never restarted the loop = "infinite
  game over"). `_pub` flag gates the dead-beacon on stop so the global exit-sweep can't emit a spurious beacon.
  Filter `sl_` rows out of any kh_presence DISPLAY (done in the admin "ONLINE NOW" list).
- **Copy/Paste toolbar** (`#kh-cp-toolbar` + its IIFE): now STICKY — tapping an input sets it as the
  paste target and KEEPS the toolbar open (a collapsed selection no longer auto-hides it while an input is
  focused), so you can paste WITHOUT first selecting text. Fixes "menu vanishes after 0.5s when pasting" +
  "needs to highlight to paste". Adds an **Ask AI** button (`#kh-cp-ai`, shown only when `khiEnabled()`) →
  `_khAskAI(text)` overlay calling `khiCall`.
- **Silk `navigator.onLine` fix**: `_khSubmitScore`/`_khFetchScores`/`_logVisit` used `!navigator.onLine`,
  which is `undefined`→truthy on Kindle Silk → scores never submitted/shown and visits never logged. All now
  use `navigator.onLine===false` (the lenient pattern Slither/cloud-sync already use). This was "global
  leaderboard shows nothing on Kindle".
- **Guest visitor stats**: `_logVisit` packs a `g|`/`u|` (guest/signed-in) flag into `kh_visits.ua_hint`
  (NO schema change); `_visitUaClean`/`_visitIsGuest` read/strip it; the admin USAGE STATS card shows
  GUESTS TODAY / 7D. Strip the flag wherever ua_hint is shown (`_famOf` device-family).
- **Admin Supabase cards removed**: `buildDiagnosticsCard`/`buildBackendCard`/`buildUserBackupCard` are no
  longer appended in the admin panel (functions kept as dead code). Cloudflare gateways + capacity guard stay
  in `buildLocalInsightsCard`.
- **KindleOS custom-app back = FOOTER**: the `#kd-customapp` iframe overlay now has its own footer back bar
  (`_cbar`) inside the overlay; the top-left `kdBackFab` is kept HIDDEN for custom apps (was "button in the
  header"). **App Share/Import** (`_khAppShareDialog('export'|'import')`): export packs an app into a
  `KHAPP1:`+base64 code; import decodes it and `customApps.push`+`persistOS`+`buildPages` → installs straight
  onto the home grid. Per-app **Share** button + an **Import** button by the Installed Apps title.
- **Keyboard quick-toggle in Control Center** (`ccTileSpecs`, a `cycle` tile over `S.kindleKeyboardMode` →
  `_khKeyboard.refresh()`): the Settings → App Settings → "KindleHub Keyboard" card already exists but is hard
  to find from the launcher, so the same config is surfaced in the CC.
- **Offline AI** (`offlineAI`): added identity/small-talk/fact/joke/advice handlers, year-awareness via
  `NOW()`, and a question-aware fallback (was a flat "add a key" blurb).
- **Worker schema self-bootstrap** (`api-worker.js` `ensureSchema`/`SCHEMA_DDL`): the Worker now runs all
  `CREATE TABLE/INDEX IF NOT EXISTS` once per isolate (guarded by `_schemaReady`) before handling a request,
  so the D1 backend works the moment the Worker is deployed + a DB is bound — no separate "run schema-d1.sql"
  step. This was the `D1_ERROR: no such table` flood (schema never applied). `SCHEMA_DDL` is kept in sync with
  `schema-d1.sql` (still the canonical copy). Tested via the node:sqlite shim (worker_test.mjs). The user must
  REDEPLOY the worker for it to self-heal — then hit the Worker URL once and all 13 tables
  create themselves. ⚠ Do NOT paste schema-d1.sql into the D1 dashboard: the **Console** tab runs ONE
  statement per Execute, and the **Studio** (Explore Data) editor's Run only executes the statement at the
  cursor ("Executed 1/1" → one table). Use the Worker auto-create, or `wrangler d1 execute kindlehub --remote
  --file=schema-d1.sql` (runs the whole file). Setup steps live in api-worker.js + schema-d1.sql headers.
- **Draw eraser** (`BUILDERS.draw` `drawStroke`/`startStroke`/`addPoint`): the eraser now PAINTS the current
  background colour (`#fff`/`#1a1a1a`) with `source-over`, NOT `globalCompositeOperation='destination-out'` —
  old Kindle Silk WebKit ignores destination-out, so the eraser drew solid marks. Painting the bg colour is
  visually identical on the solid-background canvas and works on every engine.
- **Files app (`BUILDERS.files`, a localStorage browser)**: PROTECTED keys (`kindlehub_v5`, `kh_device_id`)
  are shown LOCKED — a 🔒 prefix on the row and NO Delete button (was a disabled-but-visible button). The
  `PROTECTED` set is defined once per folder render and used both for the row marker and to gate the Delete
  button; normal files keep Delete + Copy.
- **Migration admin-bypass** (`api-worker.js` `handlePost`): an `X-KH-Admin` token (SHA-256 ∈ ADMIN_HASHES,
  same as the RPCs) lets the bulk-copy insert otherwise-gated tables (announcements, bans) AND skip the
  per-group/feedback rate limits. `_migrateToCloudflare` sends it + retries 429 with backoff. This fixed the
  migration's `messages 429` / `announcements 403` / `bans 403`. Needs the worker REDEPLOYED + the app
  redeployed (the client must send the header).
- **Shared-key AI proxy ported to Cloudflare** (`api-worker.js` `handleGeminiProxy` + `PROXY_MODELS`, route
  `/functions/v1/kh-gemini-proxy`): same `{model,payload}` contract as the old Supabase Edge Function, daily
  cap via the kh_shared_api_usage counter, streams Gemini SSE back. Key in the Worker's `GEMINI_KEY` env
  (optional `DAILY_CAP`). Client `sharedKeyProxyUrl()` now uses `_sbBase()` so it routes to the gateway when
  set (else Supabase). This is the LAST piece needed to run fully on Cloudflare.
- **Chat message cap = 30/group** (worker `applyCaps`, was 50) + **device message cache & self-heal**:
  `_groupLookup` caches the latest 30 RAW (still-encrypted) rows per room to `localStorage['kh_mc_<code>']`
  (device-local, NOT in S). `_recoverGroupMessages(code)` re-uploads them (idempotent upsert by id) ONLY when
  `_groupLatestId(code)==='__empty__'`; `loadMessages` calls it once/group/session when a room loads empty —
  so a server-wiped room rebuilds from whoever still holds a local copy. NB: chat messages are otherwise NOT
  persisted locally (only `S.msgGroups` metadata); the live `_messages` array is session-only.
- **KindleOS launcher**: `launchKindleDesktop()`, `openApp(app)` (built-in nav OR `customHTML` iframe overlay
  `#kd-customapp`), `closeApp()`. Custom AI-built apps in `osState.customApps`. KindleOS has its OWN tour
  (`startKindleOSTour`); the App-mode guided tour (`_showTutorial`) is suppressed while KindleOS is mounted.
- **Backend (Supabase REST)**: helpers `_sbSelect/_sbInsert/_sbUpsert/_sbUpdate/_sbDelete`, `_sbActive()`.
  Tables: kh_users, kh_groups, kh_messages, kh_mail, kh_feedback, kh_errors, kh_scores, kh_announcements,
  kh_presence, kh_shared_api_usage, kh_banned_usernames, kh_rate.
- **Auth**: `authRegister/authLogin/authLogout`. Hash = SHA-256(username+password) = lookup key AND AES key.
  Offline login via `_cacheOfflineCred`/`_offlineCred` (encrypted blob cached on device, `kh_offline_cred`).
  Login UI (`_accForm` in `settings`, built via `_defer`) is a real `<form>` with `autocomplete=username/
  current-password` + a hidden submit, so the browser/OS keychain (e.g. Mac Safari) saves & autofills creds —
  the app itself never stores the plaintext password. Username prefill via `kh_last_user`.
- **Egress / backend resilience**: the big per-user state blob can move OFF Supabase to **Cloudflare R2**
  (`state-worker.js`) via `_stateGatewayUrl()` (`localStorage['kh_state_gateway']`) — zero egress fees. Helpers
  `_r2PutState`/`_r2GetState`; R2 branches in `_saveUser`/`_loadUser`/`_maybePullFromCloud` + manual Sync.
  Blank gateway = Supabase, behaves exactly as before. **Capacity Guard** (`_CAP_TAG='[[KH_CAP]]'`,
  `_refreshCapacity`/`_capEffective`/`_capSet`/`_showCapacityNotice`): admin can CLOSE new sign-ins during a
  quota emergency — stored as a reserved `[[KH_CAP]]` broadcast announcement (ANON-readable, no schema change,
  auto-expiring `until` date). `authLogin`/`authRegister` block non-admins (admin username exempt via
  `_isAdminUsername`); already-signed-in users are unaffected. Both gateway fields + the capacity controls live
  in `buildLocalInsightsCard` (Admin → Local Insights). Filter `[[KH_CAP]]` records out of any announcement
  DISPLAY.
- **Cloudflare D1 backend (`api-worker.js` + `schema-d1.sql`)**: full Supabase replacement for chat/mail/
  scores/announcements/presence/feedback/errors/bans/visits — $0 egress. `_apiGatewayUrl()`
  (`localStorage['kh_api_gateway']`) + `_sbBase()` (gateway || SUPABASE_URL); ALL REST/RPC funnels through
  `_sbBase()+'/rest/v1'` (one `_sbFetch` chokepoint + `_sbCount` + the 3 rpc callers + 4 admin-diagnostic
  fetches). `_sbActive()` true when gateway OR Supabase set. The Worker is a PostgREST subset over D1/SQLite
  (operators eq/ilike/like/gte/lt/in/not.like; upsert via `on_conflict`; owner_secret gating via X-KH-Secret;
  the 7 RPCs + cap/rate triggers ported to code; JSON/bool columns marshaled). Blank gateway = Supabase,
  unchanged. **Realtime is Supabase-only** — gated off when the gateway is set (`subscribeRealtime` + the game
  multiplayer ws both bail), so chat uses its 15s polling fallback; instant realtime via Durable Objects is a
  Phase 2. STILL on Supabase even with the gateway set: the shared-key **Gemini Edge Function**
  (`/functions/v1/kh-gemini-proxy`, line ~23004) — port separately if fully decommissioning Supabase. Tested
  via a node:sqlite D1 shim (`--experimental-sqlite`): worker unit + full client↔worker↔SQLite integration.
- **Cloudflare free-tier budget guard (make it IMPOSSIBLE to hit the limits)**: free plan = Workers
  100k requests/day + D1 100k row-writes/day (both reset 00:00 UTC) + D1 5GB / 5M reads/day; R2 10GB +
  $0 egress. **Worker side** (`api-worker.js`): `dailyUsed(DB,isWrite)` counts every request per-isolate
  and flushes the delta to `kh_daily(date,n,w)` in BATCHES (~1 write per 40 requests / 20s — so the
  counter itself can't burn the write budget), reading back the global total. Past `REQ_HARD_CAP=90000`
  non-admin gets `503 {code:CF_DAILY}`; past `WRITE_HARD_CAP=90000` non-admin WRITES get `503 {code:CF_WRITE}`
  while READS stay up (site goes read-only, not down). Admin token (`x-kh-admin`) bypasses both; `/` health
  check never gated. `kh_daily` gains `w`; `ensureSchema` runs a best-effort `ALTER` for older DBs. **Client
  side** (`index.html`): `_sbFetch` is the chokepoint — on a 503 it calls `_khCfOn503` which parks ALL
  (CF_DAILY) or just WRITE (CF_WRITE) traffic for 15 min and toasts once. Every background poller/beacon
  checks `_khCfBlocked(isWrite)` first: presence heartbeat, Slither `_publish`/`_poll`, online-game poll,
  chat notifier, active-chat poll. Frequencies trimmed to cut baseline writes: Slither beacon 1.8s→2.8s
  (TTL 7s→8.5s), online-game poll 2s→3s, presence 25s→40s (kept under the 60s online window); chat poll
  also pauses on `document.hidden`. Chat send shows a friendly "briefly read-only" toast on 503 (draft
  kept). Tested with the node:sqlite shim (`budget_test.mjs`) + headless (`validate_cf.cjs`).
- **Per-IP rate limit (anti-abuse — one source can't burn the shared daily budget)**: both `api-worker.js`
  and `state-worker.js` have an `rlHit(ip,limit,windowSec,tag)` helper (Cloudflare Cache API — free, no KV,
  per-colo, fail-open if cache is unavailable so it NEVER blocks legit traffic). api-worker: burst
  `RL_BURST=100`/10s + daily `RL_DAY=20000`/IP (both env-tunable) → 429 `{code:CF_IP}` for non-admin past
  either; admin (`x-kh-admin`) bypasses; checked AFTER the `/` health check, BEFORE the budget guard. The
  burst stops floods; the per-IP daily bounds one IP well under the 90k global so a single abuser can't trip
  read-only for everyone (distributed botnets still need the global guard + Cloudflare Bot Fight Mode).
  state-worker: GET 300/5min, PUT 50/5min per IP (stops R2 junk-blob spam). Tested via the node:sqlite shim
  with a mocked Cache API (`ratelimit_test.mjs`): under-limit→200, over-burst→429, other IPs unaffected,
  admin bypasses. NB: regression tests don't define `caches`, so `rlHit` fails open (returns false) there.
  ⚠ The PUBLIC repo ships real `SUPABASE_URL`/`SUPABASE_ANON_KEY` (anon key is public-by-design + RLS-gated,
  but insert-spammable) — and `KH_DEFAULT_API_GATEWAY=''` means users WITHOUT the gateway in localStorage
  fall back to Supabase (UNGUARDED — the budget/IP guards only protect the D1 worker). To actually protect
  everyone: set `KH_DEFAULT_API_GATEWAY` to the D1 worker URL in the source (routes ALL users to D1), THEN
  blank/rotate the Supabase creds. CORS is env-driven (`ALLOW_ORIGIN`, default `*`); not hardcoded to a
  domain because a wrong value breaks the live app, and CORS doesn't stop scripted abuse anyway.
- **Chat storage bound (delete past the limit, not just hide)**: per-room cap = 30 (`KH_MSG_CAP_MAX`), EXCEPT
  the Global Chat room (`KH_GLOBAL_GROUP_CODE='000000000000'`) which keeps **50** (`KH_MSG_GLOBAL_CAP=50`);
  client never fetches more. The Worker `applyCaps` DELETEs every kh_messages row beyond that cap per
  `group_code` on every insert (incl. during migration, which writes through the same POST path so it self-
  trims) + a 3%-chance global `ROW_NUMBER() OVER (PARTITION BY group_code)` sweep that branches the keep-count
  on the global code (worker consts `GLOBAL_GROUP_CODE/GLOBAL_MSG_CAP=50/GROUP_MSG_CAP=30` — keep in sync with
  the client). So over-limit messages are removed from D1, not just unloaded. Migration read capped newest-
  first (≤3000 msgs/2000 mail). NB the admin "MESSAGES" stat is a LIVE `_sbCount` (relabelled "in cloud now"),
  bounded by groups×cap — NOT a cumulative all-time total. ~1196 groups (chat+DM+inbox+game) × cap explains
  why the count looks larger than the 286 real chat rooms.
- **Accent colour reaches far more UI**: in the `<style>`, high-visibility surfaces are repointed from
  `var(--fg)` to `var(--accent)` — `.btn.primary`, active nav tab, `.msg.user`, `.toast`, `.progress-fill`,
  input focus border, unread dot, `a{}`/`::selection`, and Wordle/Hangman/Sudoku/quiz "correct" tiles. Every
  theme defines `--accent`===`--fg`, so a user who hasn't picked an accent sees ZERO change; picking one now
  restyles broadly. (Simple/e-ink mode still forces accent→black for contrast — colour only shows on real
  colour screens, e.g. Mac.)
- **Code-free chat requests** (`_khMessageUserPicker`/`_khOnChatRequest`/`_khAcceptChatRequest`/
  `_khDeclineChatRequest`, `S.chatRequests`): the Messages list "✎ Message" button searches users (avatars +
  censored names via KH_MP.findPlayers) → creates a private group → drops a `CHAT_REQUEST` on the target's
  inbox via the NEW `KH_MP.sendChatRequest` (reuses the deterministic inbox-group plumbing). Unlike `DM_INVITE`
  (auto-joins), CHAT_REQUEST surfaces a pending "CHAT REQUESTS" card with Accept (joins) / Decline (tombstones
  the code in `S.leftGroups` so an inbox replay can't re-prompt). Announcement-target type-ahead also got
  avatars. So you can DM anyone by username — no 12-digit code to share.
- **Mail reply threading**: expanding a RECEIVED email shows your replies inline ("YOUR REPLIES") via
  `_mailReplies(id)` (kh_mail where `reply_to=<id>` AND `from_id=<me>`, decrypted under `mail:`+to_user — a key
  the sender re-derives). Read-only, async, CF-throttle-aware.
- **Admin AI "ask about a user"** (`_khAskAboutUser`/`_khGatherUserContext`/`_khAskUserDialog`): gathers a
  user's cloud METADATA (email, last sync, msg count + recent group/ts/device/location hints, presence
  last_seen) and asks `khiCall` (temp 0.2, "answer from ONLY this data") — e.g. "when was X last online?".
  Message bodies are E2E-encrypted so it reasons over metadata, not text. HARD-gated `window._isAdminCached`;
  entry points = admin USAGE-STATS card + "🔍 Ask AI" on the chat About-user modal. General Assistant stays
  open to all — only cross-user queries are admin-only.
- **AI moderation of user reports** (client `_khAITriageReport` + worker autonomous moderator): a username
  report runs the AI, which records `AI: <BAN|WARN|ESCALATE|IGNORE|NEEDINFO> — reason` into the kh_feedback
  report. Admin reporters auto-apply a confident BAN/WARN (`_khWarnUsernameSilent` = non-interactive warn).
  For everyone else, the **api-worker `scheduled` cron** (`runAutoModeration`/`geminiOnce`, opt-in via env
  `AUTO_MOD`+`GEMINI_KEY`; `ADMIN_USERNAMES` never touched; `MOD_MODEL`/`MOD_MAX`; `crons=["0 * * * *"]`)
  reads un-actioned `[USERNAME]` reports and applies the decision SERVER-SIDE — ban (kh_banned_usernames),
  warn (targeted kh_announcement), ignore, or leave open for a human — reusing the client verdict or asking
  Gemini. Reports tagged `[auto-mod]` so they're actioned exactly once → KindleHub self-moderates for weeks
  with no admin online. Tested via node:sqlite (`automod_test.mjs`).
- **Backend wording**: the live admin/help strings are backend-generic now (no hard-coded "Supabase" in the
  error-log toast/note, cleanup heading, gateway toasts/help, capacity guard, guide lines) — "Cloudflare D1 /
  Supabase" or "the default backend". (Migration button/dialog keep "Supabase" — they genuinely read FROM it.)
- **Cloud sync merge** (`mergeCloudState`): id-lists (notes/books/flashDecks/mdJournals/calEvents/advStories)
  are UNIONED by id, so deletions need git-style tombstones — `S.deletedItems` (`<list>:<id>`→ts, SYNCED &
  unioned across devices like `leftGroups`) recorded by `_khTrackDeletions()` (a save-time diff of the lists
  vs `window._khPrevIds`, so NO per-delete-site wiring) and skipped by the merge, so a pull/reload never
  resurrects a deleted item. Re-adding an id clears its tombstone. GC: 180-day age + 2000-entry cap. Item id =
  `_khItemKey()` (id→uid→title@date→json), used by BOTH the tracker and the merge so keys line up.
- **Moderation**: profanity filter `_censorText`/`_hasProfanity` (DISPLAY-side only, used in chat, feedback
  AND notification toasts via `notifyMsg`) — two passes: exact word-boundary (`_PROFANITY_WORDS`) + embedded
  roots (`_PROFANITY_SUBSTR`, leet-normalised, guarded by the `_PROFANITY_SAFE` allow-list to dodge the
  Scunthorpe problem). Actions: `_khBanUsername`/`_khUnbanUsername` (kh_banned_usernames RPC) and
  `_khWarnUsername(name)` — a lighter warning delivered as a PRIVATE targeted announcement (no new schema).
  Admin surfaces: the chat "Admin About" modal (`_openUserAboutModal`) and the feedback review of
  `[USERNAME]` reports (which are user ban-requests, stored in kh_feedback) — both have Warn + Ban.
  **Coverage sweep**: an adversarially-verified pass closed 17 remaining display-side gaps where
  user-generated text reaches OTHER users uncensored. `_dispName` (name = ban-list + censor) now wraps:
  global-leaderboard names, admin ONLINE-NOW names, feedback comment authors, chat reply-preview +
  report-modal author, DM group-name (`otherName`+`myShort`), and the lobby "invite sent" name; the
  single mail-address choke point `_addrLbl` censors the local-part (covers mail list + reading-pane
  From/To). `_censorText` (free text) now wraps: KindleOS app-share dialog title, group-name confirm/
  leave/mute toasts, online-game JOIN/opponent toasts (tic-tac-toe, connect4, generic lobby), and the
  report-modal quoted message text. Rule kept: a user's OWN private content (notes/journal/drafts) is
  never censored — only text shown to others. Both helpers are global `function` decls (hoisted), safe
  to call from inside game IIFEs.
- **Encryption**: `_encryptState/_decryptState` (user state), `_msgEncrypt/_msgDecrypt` (chat & mail).
- **AI**: `khiCall(prompt,opts)` (user's Gemini/OpenRouter key), `khiEnabled()`. Shared-key proxy too.
- **Tiers + header**: `_khTier()` = `creator` (admin = `window._isAdminCached===true`, via `_checkAdmin`),
  `ultra` (earned/active), or `pro`. `_khUpdateHeaderBadge()` brands the logo **KindleHub Ultra** for
  creator/ultra (else **Pro**) and shows a pill: **ADMIN** (creator) / **ULTRA**. Storage caps (`_storageLimit`):
  creator 12 MB, ultra 3 MB, pro 1.5 MB. The over-budget storage banner (`_checkStorageHealth`) is gated on the
  tier being RESOLVED (`typeof window._isAdminCached==='boolean'`) so it can't flash during the boot window
  before `_checkAdmin` runs (that race was the admin "storage full" false-positive). Header buttons are compact
  (Landscape=`⟳`, KindleOS=`OS`) + a `body.simple-mode .header-controls` override so the Recent/multitask button
  always fits.

## Supabase storage/bandwidth (78+ users — keep this in mind)
- **Egress** was the big cost; fixed by `_groupLatestId` probe before pulling chat bodies, and the
  cloud pull checking `updated_at` before downloading the big state blob.
- **Storage** capped via triggers (in BOTH schema.sql and the in-app admin SQL — re-run schema to apply):
  kh_messages 50/group, kh_mail 60/recipient, kh_errors ~600 global. kh_feedback done/ignored items
  auto-prune after 7 days (needs `status_at` column + `kh_feedback_delete` policy from the schema).
  **Feedback auto-prune now runs SERVER-SIDE on Cloudflare** (was admin-panel-only): the worker
  `applyCaps` deletes `status IN ('done','ignored') AND COALESCE(status_at, date) < now-7d` on every
  kh_feedback insert, and the `scheduled` cron runs the same DELETE every tick (ALWAYS — not gated on
  AUTO_MOD). `COALESCE(status_at, date)` ages out LEGACY rows that were resolved before status_at existed
  (by creation date) — that's what clears the old backlog that used to stack up. `handleDelete` for
  kh_feedback + the admin-panel client prune use the same COALESCE rule, so resolved items also vanish
  the moment the admin opens the panel.
- **⚠ The user must RE-RUN the schema SQL** (Supabase SQL editor or Admin→Diagnostics) to apply new
  triggers/columns/policies after each schema change.

## Deploy / "how do I get the changes"
1. Merge the open PR for branch `claude/keen-tesla-n73rpc` into `main` (GitHub → Merge).
2. Download **`index.min.html`** from `main`, rename it to `index.html`, and upload to the host. (It's the
   minified deploy build — ~22% smaller than the source, so it parses/loads faster on the Kindle. The
   readable source you edit is still `index.html`.)
3. Site is behind **Cloudflare** — if changes don't show, **Purge Everything** (cache).
4. For real internet email: deploy `email-worker.js` (full setup guide in its header), paste its URL into
   Admin → Local Insights → Mail gateway (`localStorage['kh_mail_gateway']`).
   - **email-worker.js now stores mail on Cloudflare D1** (full migration): its backend base is
     `env.API_GATEWAY || env.SUPABASE_URL` (`_base`/`_bhdr` helpers), so set `API_GATEWAY` to the D1
     api-worker URL and inbound/outbound mail lands in the SAME D1 database as everything else (no
     SUPABASE_SERVICE_KEY needed). Falls back to Supabase only if API_GATEWAY is unset. Outbound still
     uses Resend (free 100/day; worker caps DAILY_SEND_CAP=80) — the one paid-tier risk if volume grows.

## ⚡ Latest session — new features, fixes, env vars, branch (READ THIS)
**Active dev branch is now `claude/keen-tesla-n73rpc`** (not wonderful-clarke). All work below is on it.
**NEW Worker env vars (set on the D1 api-worker):**
- `KH_PEPPER` (recommended) — envelope-at-rest. Worker AES-GCM-wraps sensitive columns (`kh_users.state`,
  `kh_mail` subject/body, `kh_messages.text`) with `KHW1:` prefix before writing D1, unwraps on read
  (`wrapCell`/`unwrapCell`/`unwrapRows`, `WRAP_COLS`). A STOLEN D1 is useless without the pepper. Opt-in
  (unset = no-op), backward-compat (legacy rows pass through), no client change. ⚠ KEEP IT FOREVER once set
  (losing it = wrapped rows unreadable). Test: `/tmp/envelope_test.mjs`.
- `MOD_HASHES` (optional) — comma-sep SHA-256 of moderator codes. Unlocks ONLY the `kh_mod_stats` RPC
  (aggregate COUNTS: users/online/visitors/messages/rooms/feedback — never rows/PII). `isMod(token,env)`;
  a mod token can't ban/announce/read gated tables (server-enforced). Client: Settings→Account→"Moderator
  tools" (`_khModStats`/`_khBuildModCard`, code in `kh_mod_code`). Grant/revoke via the env, no deploy. Admins
  are implicitly mods. Test: `/tmp/mod_test.mjs`.
**Scaling / capacity (SCALING.md):** adaptive fleet backoff — Worker stamps `X-KH-Load` (% of daily free
budget used, from `dailyUsed`/`_loadFrac`) on every response (in `cors()`); client `_sbFetch` reads it →
`window._khLoad`; background pollers call `_khLoadSkip()` (skips ticks once load >55%, ramps to ~85%). Presence
40s→70s + online window 60s→150s. So the free-tier cap is approached asymptotically, never tripped. For a HARD
5000-user guarantee: Workers Paid $5/mo (10M req/day). Test: `/tmp/loadhdr_test.mjs`.
**New apps/views (BUILDERS + nav tab + NAV_TABS entry, hardcoded `<div class="tab" data-view=..>` in nav HTML):**
- `imagesearch` ("Images") — Openverse image search (`api.openverse.org/v1/images`, CORS-open, no key,
  `mature=false`), thumbnail grid + Load more + full viewer. For Kindles that can't reach Google/Pinterest.
- `sports` ("Sports") — ESPN scoreboard (`site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard`,
  CORS-open, no key). Leagues NBA/NFL/MLB/NHL/Soccer(eng.1)/NCAAF/NCAAB. Avoids Array.find (old-Silk).
**Notification Center** — swipe-up bottom sheet (`_khPushNotif({icon,title,body,view,group})`, `_khOpenNotifs`,
device-local `localStorage['kh_notifs']` cap 25, handle+badge). Fed by chat (`notifyMsg`) + game invites
(`_renderInvite`). Extensible to announcements/mail. IIFE right after `notifyMsg`.
**Ultra tier changes:** threshold 10→15 min/day (`ULTRA_MIN_SEC=900`), 3 days/week; ONLY accrues when signed
in; online games are Ultra-gated via `_khRequireUltra('...')` at the single choke point `KH_MP.openLobby`; the
Settings Account card no longer says "admin" (creator sees "You are the Creator"). `_khUltraActive` already
required auth.
**Admin daily stats:** `_logVisit` packs tier into ua_hint (`g|` guest, `u|` signed-in Pro, `U|` Ultra/Creator);
`_visitIsSignedIn`/`_visitIsUltra`; admin USAGE STATS shows SIGNED-IN TODAY / GUESTS TODAY / ULTRA TODAY.
**Chat:** progressive render — newest `_CHAT_PAGE=10`, "Load earlier" button (scroll-preserving) in
`renderMessages`; no two groups you're in can share a name (create-time check). Backend label now reports the
REAL backend (Cloudflare D1 via `_apiGatewayUrl`), not hardcoded "Supabase".
**Announcement comments** (public thread per announcement): the home widget's each announcement gets a
"💬 Comments (N)" button → `_openAnnouncementComments(a,card)` modal (mirrors the feedback `_openCommentThread`).
Reading open to all; posting needs sign-in (re-reads the row, appends `{id,author,text,date}`, caps newest 60,
PATCHes `comments`-only, NO admin token). Display profanity-filtered (`_censorText`/`_dispName`). Stored in a
JSON `comments` column on kh_announcements. **Worker gate** (`api-worker.js`): `comments` added to
COLUMNS/JSON_COLS/UPDATE_OK for kh_announcements + a handlePatch rule filtering a NON-admin PATCH to `comments`
only (text/active/targets untouchable from the client — verified vs a mixed-PATCH piggyback attack). SCHEMA_DDL
+ best-effort ALTER add the column (`'[]'`). The two announcement loaders now `select=...,comments`. Tests:
`/tmp/anncomment_test.mjs` (worker, 8/8) + `/tmp/anncomment_client.cjs` (client UI).

## ⚡ Round: Gazette + unified pickers + Jailbroken Layout + Retro + Dashboard + perf
Six-part user request, each its own tested+committed batch on `claude/keen-tesla-n73rpc`:
- **The Kindle Gazette** (`BUILDERS.gazette`, nav tab + `['gazette','Gazette']`): AI daily newspaper. Default
  "Daily" edition = **shared/public key** (`khiCall(prompt,{provider:'shared',temperature:0,maxTokens:1500})`)
  so it's free + effectively same-for-all (fixed public feeds + shared model + temp 0); cached per-day in
  `localStorage['kh_gazette']` (`{date,public:{headline,lead,stories,model,at},custom:{…}}`) — NEVER in S.
  "✎ Custom" edition = the **canonical model picker** (`buildAIModelPicker`) → own API or shared + reader
  interests (`S.gazetteTopics`) + followed feeds, via `khiCall(prompt,_khiOptsFromPicker())`. Headlines from
  a fixed `GAZETTE_FEEDS` set via rss2json (CORS-open, same plumbing as News). Offline→saved edition; AI-down→
  raw wire fallback. Newspaper layout (serif masthead, `column-count` 2-up on wide, 1 on e-ink). Test:
  `/tmp/gazette_test.cjs`.
- **Unified model pickers**: the Assistant's `buildAIModelPicker` (returns `{btn,drop,label,rebuild}`, writes
  S.aiProvider/hbGeminiModel/openrouterModel/anthropicModel/openaiModel) now also powers the **Test AI
  Connection** dialog (chat "Test" btn) and the **AI self-fix / prompt-an-edit** dialog (dropped its OpenRouter-
  omitting provSel/modelSel + the temp S-swap; picker persists the choice). LEFT specialized (documented):
  KindleOS support bot (manual-grounded bespoke send path — stream fns bake in `buildSYS()`, can't take the
  support system prompt) + KindleOS store per-provider key-entry panels. Test: `/tmp/picker_test.cjs`.
- **Jailbroken Layout** (premium, Ultra/Creator-gated via `_khRequireUltra`): Settings toggle (`.kh-switch`,
  `S.jailbrokenLayout`) → Fullscreen API (vendor-prefixed `_khJbRequestFs/_khJbExitFs`) + Web Audio unlock
  (`_khJbUnlockAudio` resumes a shared `window._khAudioCtx`; `_khJbBeep` test tone) + immersive `body.jailbroken-
  layout` full-bleed CSS. All feature-detected (`_khJbCaps`) + try/catch → on KOReader/no-fullscreen engines the
  CSS layout still applies (never a dead end); a live capability readout shows what the engine supports. Persist:
  `applyCustomisation` re-applies the class at boot + arms a one-time next-tap re-enter (fullscreen/audio need a
  gesture); `fullscreenchange`→`.kh-fs` body class. Helpers are top-level after `_khiOptsFromPicker`. Test:
  `/tmp/jailbroken_test.cjs`.
- **Retro UI polish** (`body.simple-ui`): app icons now framed "desktop tiles" (54px bordered+shadow), new
  windowed masthead (`.simple-masthead` monospace title bar + serif "Hello, <name>" greeting via NOW()), framed
  feature icons, serif titles + Courier labels, double-rule section header. Full dark+sepia parity. All static
  (e-ink-safe). CSS in the main `<style>` (~627+); masthead built in the `uiMode==='simple'` home branch. Test:
  `/tmp/retro_test.cjs`.
- **Personalized Dashboard** (`BUILDERS.dashboard`, nav tab near front + `ALWAYS_REBUILD` so counts stay fresh):
  greeting+date (NOW()), daily-goal card sharing `S.dailyGoal` w/ the Home widget (set inline / Mark done /
  🔥streak, same yesterday-carry logic), 6 tappable stat tiles (Books/Notes/Journal/Chats/Events/Games-played →
  jump to view), continue-reading (last `S.books`), today's Gazette headline (from `kh_gazette` cache), quick
  actions. Defensive reads, theme-var CSS (works in Retro/dark/sepia). Test: `/tmp/dashboard_test.cjs`.
- **Perf**: `@supports (content-visibility:auto)` hint (+`contain-intrinsic-size`) on `.simple-app`/`.dash-tile`
  grids (`perf-css` IIFE) — skips off-screen paint on modern engines, no-op on Silk. (App already view-cached +
  tick-guarded; deep Kindle-parse perf is a separate effort.)
NB: `S.jailbrokenLayout`/`S.gazetteMode`/`S.gazetteTopics`/`S.dailyGoal` are small S fields (auto-persist).

## ⚡ Round: notif arrow + friends + app-share + multiplayer foundation
- **Notification handle redesign** (the `notifyMsg`-adjacent Notification Center IIFE ~3264): the floating "🔔
  Notifications" pill (tofu on Kindle + intrusive) → a THIN bottom-edge strip drawing an inline **SVG chevron**
  (never a font glyph, so no tofu). Teaches-then-hides: shown while unread OR until first open; opening sets
  `localStorage['kh_notif_swiped']` and the teaching arrow stops (reappears thin for new unread, hides when
  read). `_showHandle()` gates visibility; `_learned` flag. Test: `/tmp/notif_handle_test.cjs`.
- **Friend requests + friends list** (Messages): two-way inbox handshake reusing the chat-request plumbing.
  `_khOnFriendRequest`/`_khOnFriendAccept`/`_khAcceptFriendRequest`/`_khDeclineFriendRequest`/`_khRemoveFriend`/
  `_khMessageFriend`/`_khAddFriendPicker` (all `window.`-exposed, near `_khMessageUserPicker`). KH_MP gains
  `sendFriendRequest`/`sendFriendAccept`; dispatcher routes `FRIEND_REQUEST`/`FRIEND_ACCEPT`. **Security:** only
  the 16-char hash PREFIX (what findPlayers already exposes) is exchanged/stored — never the full AES hash. UI
  in the Messages list render (`render()`): FRIEND REQUESTS card + FRIENDS(n) list + "+ Add". `S.friends`/
  `S.friendRequests` (in defaults). Test: `/tmp/friends_test.cjs` (13/13).
- **Share apps in chat**: apps travel as the existing `KHAPP1:` code (pure text, no media). Globals
  `_khAppCode`/`_khInstallAppFromCode`/`_khAppCodeLabel`/`_khAppMsgCard` (near the friend helpers). Composer
  "+" attach → app-share sheet → sends the code via the NORMAL send path (`txtArea.value=code;sendBtn.click()`);
  the `renderMessages` bubble hook detects a `KHAPP1:` message → renders an Install card (safe import: 512KB
  cap + REGENERATED safe icon, never trusts obj.icon; chat cap 16KB). Test: `/tmp/appshare_test.cjs`.
  **Screenshots-in-chat DEFERRED** — sending the image needs the media storage the user chose to skip.
- **Online multiplayer FOUNDATION (step 1)** — `KH_MP.partyHello/getRoster/partyStart` + `KH_MP.openParty(
  {gameName,maxPlayers,minPlayers,onStart})` lobby (create/join a 2-4p room, live poll-based roster, host Start
  at minPlayers → `onStart(session,roster)`; guests listen for `PARTY_START`). Reuses the 900000-room channel +
  send/subscribe/_groupFetchMessages (no worker/realtime change yet). Ultra-gated. `getRoster` dedupes
  PARTY_HELLO beacons by user (latest wins) within a freshness window, host-first. Test: `/tmp/party_test.cjs`
  (12/12). **NEXT:** wire the first playable 3-4p game (e.g. online Trivia) to `onStart`.
User decisions this round (via AskUserQuestion): Messages first = Friend requests + Share apps/screenshots;
images/GIFs = SKIP (no media backend); online games = START NOW. Screenshot-in-chat still pending the media call.

## ⚡ Round: game bugs + warn/ban flow + Farm game + Find launcher
- **Game bug fixes**: Snake canvas `max-width:100%` had no `height:auto` → squished tall on narrow Kindles;
  added `height:auto;aspect-ratio:1/1` (true 1:1). Minesweeper flagged cell used `background:var(--unrev)` (same
  as unrevealed) w/ no text colour → the 'F' was invisible; now `background:var(--accent);color:var(--accent-inv)`.
  DigQuest jump worked ~1/100: the queued jump was consumed+cleared even when `onGround` was false, and onGround
  flickers false for a tick after landing (0.01px snap gap) → added a jump BUFFER (`jumpBuf=JBUF=8`) + COYOTE
  time (`coyote=COYOTE=4`) in `step()` — the standard platformer fix. Anagrams bank ~52→~140; Nonogram puzzles
  8→28 (all 5×5). Test: `tools/games_test.cjs` (35 games, 0-flagged).
- **Warn/ban flow** (`_WARN_TAG='[[KH_WARN]]'`): warnings are targeted announcements tagged `[[KH_WARN]]` and
  ROUTED OUT of the general announcements widget for everyone except the target (the widget filter checks the
  current user is in `a.targets`) — so warnings/bans no longer clutter the admin's (or anyone's) announcements.
  The WARNED user still gets theirs + sees it prominently: a big blocking modal on home (`_khMaybeShowWarningModal`,
  once, `kh_warn_ack`) + a red-bordered card in the widget (`_dispAnnText` strips the tag). Admin panel (Feedback
  view) gets a red **Moderation notices** card (`_khRefreshModerationCard`, `#kh-mod-card-host`) listing active
  warnings w/ Delete. Ban-request rows show **already warned** via `_khLoadWarnedSet()` (set of warned usernames
  from warn announcements, loaded into `window._khWarnedSet`). Tofu-safe: dropped ⚠ from the warn text/label; the
  modal uses a CSS "!" circle. `_khWarnUsername`(+Silent) prepend `_WARN_TAG`. Test: `/tmp/warn_test.cjs`.
- **Farm** (`const Farm`, game #35): cosy turn-based farming sim — 4×3 plots, seed shop (Wheat/Carrot/Berry/
  Pumpkin, cost/grow/sell), "Next day" grows all crops, tap a READY crop to harvest+sell for coins. No loop
  (renders per-action like Minesweeper); state persists in `S.games.farm` (plots/coins/day/seed/best). Wired:
  `_doLaunch` case + `GAME_HELP`/`GAME_MAP` + a card in the Games grid (rowBoard) + `tools/games_test.cjs` id.
  Test: `/tmp/farm_test.cjs`.
- **Easier navigation**: a **"Find" launcher** — a `.nav-launcher` accent chip at the START of the nav (not a
  `.tab`, so the tab click/reorder logic ignores it; inline `onclick=_khOpenLauncher()`) opens a searchable
  overlay of all ~38 pages (from `NAV_TABS`+home) with RECENT pages as chips; type to filter, tap/Enter to jump
  (navigates via the real nav tab so split-screen stays correct). Plain "Find" text (no tofu). Test:
  `/tmp/launcher_test.cjs`.
**Timer/Stopwatch:** Pomodoro card retitled "⏱ Timer, Stopwatch & Pomodoro"; added `startCustom(mins)` +
a self-contained count-up stopwatch (`swToggle`/`swReset`/`#swDisplay`).
**Restart-logout fix:** the gzip state blob can fail to inflate on a cold Kindle boot (→ logged-out default);
a tiny UNCOMPRESSED `kh_session` mirror (`_writeBootHints`) is restored at boot if the main blob lacks auth.
**Double-keyboard fix:** KindleHub keyboard now also toggles `readOnly` (not just `inputmode='none'`, which old
Silk ignores) in `applyInputmodeAll`/`_attachToTarget`/observer; `typeChar` writes value programmatically so
readOnly is fine; restored on disable.
**Crash fixes:** Space Invaders `tick` snapshot score BEFORE `stop()` (was "score of null"); adventure
`advance()` post-await `if(!_adv)return`; `reportError` ignores 3rd-party beacon errors (Cloudflare Web
Analytics `beacon.min.js/v<hash>` "Unexpected token ." on Silk — matches `cloudflareinsights|beacon\.min\.js|
\/cdn-cgi\/|rocket-loader|\bv[0-9a-f]{24,}`; also turn OFF CF Web Analytics in dashboard).
**Security/UI fixes:** leaderboard `kh_scores` score clamped server-side (≤999999999, int, name≤40); message
`location_hint` now stamped SERVER-SIDE from `request.cf` (city/region/country) in handlePost — reliable +
spoof-proof (client ipapi.co call removed); kh_feedback PATCH now allows non-admin `comments` (was votes-only
→ "no valid columns" bug) but still blocks status/text/author; ALL reports get Warn/Ban (parse `By: <name>`
from `[REPORT]` items, not just `[USERNAME]`); canvas `var(--fg)` resolved to real colours (Pomodoro/Weather/
Wheel were invisible on dark); Mindfulness `inset`→longhand; 45 modal overlays + `#toastRoot` mount into
`rotateRoot||body` (landscape); Pomodoro no longer rebuilds log+chart every second; Sudoku incremental
`paintCells` (no full rebuild per tap); dark accent kept readable via `_accentForBg`.
**Worker tests (node --experimental-sqlite):** envelope_test, mod_test, geo_test, score_test, loadhdr_test,
fbcomment_test, worker_acl_test — all in /tmp, all passing. Client headless: /tmp/uibugs_validate.cjs (boot),
crash_test, notif_test, timer_test, imgsearch_test, sports_test, kbsession_test, ultra_test, stats_test.
⚠ **DEPLOY GATES:** migrate all users to D1 BEFORE the Supabase-severed build goes live (else logins break);
set `KH_PEPPER` (+ `MOD_HASHES` if granting mods); redeploy api-worker.js; upload index.min.html; CF Purge.

## ⚡ Round: 8-ball + Stars search + Jailbroken REMOVED + Sports football + metrics + OS apps + perf
Ten-item "fix all in 1 go" batch on `claude/keen-tesla-n73rpc` (all in `index.html`, re-minified):
- **Header = date only + Recent moved** (`sysClock`/`recentBtn`): the Kindle already shows the time in its own
  status bar, so `tick()` now writes ONLY the date (`Sun 5 Jul`) — dropped the `toLocaleTimeString` parse + the
  12h/24h regex dance entirely, and slowed the clock interval 30s→60s (date changes once a day). The header HTML
  order is now `[date] [Recent] [landscape] [theme] [uiMode] [OS]` — Recent moved RIGHT past the clock so it
  sits with the other header buttons (was on the far left).
- **Jailbroken Layout REMOVED** (user asked to pull it): deleted the whole feature added last round —
  `_khInjectJbCss` IIFE (+ `.kh-switch`/`.kh-fs`/`body.jailbroken-layout` CSS), the `_khJbCaps/_khJbRequestFs/
  _khJbExitFs/_khJbUnlockAudio/_khJbBeep/_khJbSyncFs/_khJbApply` helpers + `fullscreenchange` listeners, the
  `applyCustomisation` boot re-apply block (`window._khJbArmed`), and the Settings → App Settings card (`cJb`).
  `S.jailbrokenLayout` is now an inert leftover field (harmless). The `perf-css` `content-visibility` IIFE STAYS
  (separate feature). Only `.kh-sl-gameover` (Slither) still uses a `kh-sl*` class — unrelated.
- **8-Ball stronger** (`EightBall`): `MAXPOW` 15→**26**, shot power `Math.min(MAXPOW,dl/8)`→`dl/5` — a firm flick
  now actually breaks the rack.
- **Deep Dig (DigQuest) e-ink mode removed**: the "e-ink" toggle did nothing useful on a B&W screen. Dropped the
  `ek` button (row now just "Restart chapter") and hard-set `renderEveryMs=33` (was `d.chunky?110:33`).
- **Sports: football + World Cup** (`BUILDERS.sports` `LEAGUES`): the single `['Soccer','soccer','eng.1']`
  (Premier League only) → **World Cup (`fifa.world`), Premier Lg, Champions Lg (`uefa.champions`), La Liga
  (`esp.1`), Serie A (`ita.1`), Bundesliga (`ger.1`), MLS (`usa.1`), Women's WC (`fifa.wwc`)** + the US
  leagues. ESPN slugs; World Cup loads first (it's the 2026 tournament right now). Out-of-season leagues show
  "No X games right now" (existing empty-state).
- **Stars page search** (`BUILDERS.starmap`): a **Search chip** (`.sm-fab-search`, below the city chip) opens a
  slide-down panel (`.sm-search-panel`, z-index 35 so it covers the FABs) with a search box over a combined
  index — **stars (STARS_BRIGHT+DEEP), Messier DSOs, satellites (SATS), planets (planetPos)**. Index built
  LAZILY on first open (`_smBuildIndex`, so the `const` catalogues are initialised by then), deduped by name.
  Picking a result: `_smGoTo` computes CURRENT alt/az (`_smAltAz` — `satPosition` for sats, `raDecToAltAz` for
  the rest), turns ON the matching layer toggle (`tSat/tDSO/tPlan.click()` if off), points the camera
  (`viewAz`/`viewAlt`), and opens the existing info card (`showInfo`) which shows **Alt / Az / compass
  direction** = the object's live location. Below-horizon objects still show direction + a toast. Avoids
  `Array.find` (old-Silk). Empty box shows 10 quick suggestions (ISS, Sirius, M31, …). Test: `/tmp/round_test.cjs`.
- **Admin metrics fixes** (`buildVisitsCard` + `_sbCount`): (1) `_sbCount` now sends the **`X-KH-Admin`** token
  when present (admin-gated `kh_visits`/`kh_errors` were returning null → VISIT ROWS `?` / ERRORS `—`) AND falls
  back **HEAD→GET** if a proxy strips `content-range` on HEAD (was GROUPS `?`). (2) **"NEW USERS" was a lie** —
  kh_users has NO signup column (only `updated_at`=last sync), so "NEW USERS 7d" was the SAME query as "ACTIVE",
  showing the identical 109. Relabelled to **ACTIVE 7D** (u7, +24h count) and **ACTIVE 30D** (u30) — honest,
  non-duplicate. Comment notes active>visitors is expected (visit-logging is throttled under CF load; syncs
  aren't). Note: a true new-user count needs a `created_at` column (worker+schema change) — deferred.
- **New apps in KindleOS** (`BUILTIN_APPS`): added **Dashboard, Gazette, Sports, Images (imagesearch)** with
  colored 48×48 icons. `openApp`→`showView(app.nav)` (BUILDERS fallback) + `buildPages`→`allApps()` so they
  render in the OS grid. (They were already in `NAV_TABS`/BUILDERS, just missing from the OS launcher.)
- **Retro home icons** (`ICON_LIB`): added `screenshot/imagesearch/sports/gazette/dashboard` line icons — these
  views were falling back to `FALLBACK_ICON` (a plain square), the "all the same square logo" bug.
- **Perf ("a bit faster")**: the clock simplification above (no locale parse, 60s), plus the Jailbroken removal
  cuts JS to parse/run at boot. (Deep parse-time perf remains a separate effort per the notes below.)
Tests: `/tmp/round_test.cjs` (header/JB-gone/sports/OS-apps/star-search — all green vs index.min.html) +
`tools/games_test.cjs` (35 games, 0 flagged). Minifier Silk syntax gate passed.

## ⚡ Round: kill tofu emoji + retro home reorganised + Farm depth + Find button removed
User was (rightly) annoyed: "remove ALL NOT SUPPORTED UNICODE… retro home SO DISORGANISED… Farm most
boring thing ever… what is the new Find button". Four fixes on `claude/keen-tesla-n73rpc`:
- **Tofu emoji purge**: recent features shipped astral-plane emoji that render as □ on Kindle Silk. Removed from
  DASHBOARD (🎯🔥📚📝📔💬🗓🎮📖🗞⚡🤖 → clean text headers + **inline-SVG** stat tiles via `_DSVG`), GAZETTE (📰/✎
  segment buttons → plain "Daily"/"Custom"), NOTIFICATION CENTER (icons were emoji rendered via `textContent`;
  now a keyword→SVG map `_NICONS`/`_nIcon` — callers pass `'friend'|'ok'|'chat'|'game'|'bell'`, render switched
  to innerHTML for `<svg…>`; legacy emoji notifs fall back to the bell), plus stray toasts/labels (🎱 8-ball,
  ✈ flight sim, ⚖ BMI, ⚐ report tags, 📖 habit-tool AI example → ★). KEPT: chess `♚♛♜` + card `♠♥♦♣` (game-
  critical, render fine) and everything already on the `EINK_SYMBOLS` safe list (✓✗★☆✦♥ arrows · °). Scan tool:
  a node one-liner over U+1F000–1FAFF/U+2600–27BF minus the safe set — down to just chess glyphs + one comment.
- **Retro home reorganised** (`uiMode==='simple'` branch): the flat 40-icon "All Applications" wall was the
  "disorganised" look. Now grouped into labelled shelves — **Read / Create / Play / Connect / Organise / Tools /
  Explore / More** (`CATS`), each a `.simple-section-hdr` + its own `.simple-app-grid`; Edit button rides the
  first header; hidden apps (`S.retroHidden`) skipped; any NAV_TABS view not in a category auto-appends to More
  so nothing can vanish. Masthead + featured row unchanged.
- **Farm made fun** (`const Farm`): was plant→next-day→harvest with zero depth. Now a real progression loop —
  **XP/level** unlocks crops (Wheat/Carrot→Berry→Pumpkin→Corn→Melon by `lv`); daily **weather** (`WEATHER`/
  `WKEYS`: Sunny normal, Rainy 2× growth, Dry spell = no passive growth); **watering cans** (`WATER_PER_DAY=3`,
  tap a growing plot to rush +1 day); a rolling **daily order** (`_makeOrder`, deliver N of a crop for a coin
  bonus). Still turn-based (no loop, e-ink-safe), persists to `S.games.farm` (`_norm` back-fills old saves).
- **Find button removed**: the `.nav-launcher` "Find" chip (from the earlier navigation round) confused the user
  (they'd asked for a STARS search, not a header Find). Deleted the nav chip; `_khOpenLauncher` left as inert
  dead code. The Stars page search bar (last round) stays.
Tests: `/tmp/fix_test.cjs` (find-gone, dash/gazette/retro/notif emoji-free, 6 SVG tiles, 8 retro shelves, full
Farm plant→water→ripen→harvest→persist) + `tools/games_test.cjs` (35 games, 0 flagged). Minify Silk gate passed.

## ⚡ Round: Find restored + Gazette→News tab + Dashboard removed + tofu purge 2 + shared auto-switch + walk ETA
Autonomous batch on `claude/keen-tesla-n73rpc` (user stepped away, asked to finish + merge):
- **Find chip back + Settings findable**: restored the `.nav-launcher` "Find" chip in the nav (user changed
  their mind — wanted it back); `_khOpenLauncher` page list now appends `['settings','Settings']` (Settings
  isn't in NAV_TABS) so you can search-jump to Settings too.
- **Gazette lives INSIDE News now** (not a standalone page): removed the `gazette` nav tab (HTML + NAV_TABS +
  BUILTIN_APPS + retro ICON_LIB/CATS). Added a **Gazette view-tab** to the News (`rss`) view — `VIEW_DEFS` gains
  `{id:'gazette'}`, `renderContent` dispatches `renderGazette()` which lazily mounts `BUILDERS.gazette()` (still
  closure-based, so it hosts fine) into `contentDiv` and caches it. Feed-filter tabs hide off the Feed tab.
- **Dashboard removed ENTIRELY** (user: "remove dashboard page entirely"): deleted `BUILDERS.dashboard` (+ its
  `_go/_num/_gamesPlayed` locals), the nav tab, NAV_TABS entry, BUILTIN_APPS entry, retro ICON_LIB `dashboard`,
  retro CATS `dashboard`, and `dashboard` from `ALWAYS_REBUILD`. The Home daily-goal widget (shares S.dailyGoal)
  is untouched.
- **Tofu emoji purge #2** ("make sure no not working emojis get through"): a full non-ASCII scan (safe set =
  ASCII + EINK_SYMBOLS + basic punctuation/accents) found & fixed every remaining rendered emoji/dingbat —
  ⚠→"!" (incl. the `⚠?` strip-regex → `!?`), ✕→× (close buttons, Latin-1 renders), gazette `↻ Refresh`→Refresh,
  and one-offs (⤓ Import, ↺ reset btn, ⇌ swap-lang btn→Swap, ☰ menu hint, chem `⇌`→`<=>`, Wikipedia ↗, `⇪`→↑,
  atbash `A↔Z`→`A=Z`). Only KEPT: chess `♚♛♜♝♞♟` (game-critical, render fine) + two code comments (😀 in the
  EINK explanation, ↔ in a palette comment). Scan is repeatable (node one-liner in the round tooling).
- **Public/shared AI: auto-switch on 503 + a real model picker** (user: "public api always overloaded → auto
  switch + model picker"): `callSharedGeminiStream` — a 503/500 from a model now `continue`s to the NEXT model
  in `SHARED_KEY_FALLBACK_CHAIN` (it used to just retry the SAME model then give up = "always overloaded"); if
  the WHOLE chain is overloaded, one backoff-retry (`_ai503Retry`) then a clear message. NEW `S.sharedModel`
  preference is tried FIRST (chain reordered), rescued by the rest. The **model picker** (`buildAIModelPicker`)
  now, when provider==='shared', lists exactly the `SHARED_MODEL_QUOTAS` public models and a pick writes
  `S.sharedModel` (was writing the ignored `hbGeminiModel`); `chatModelLabel` shows "Public: <model>".
- **Maps walking ETA fixed** (user: "2.31 km = 6 min walk?!"): the public OSRM demo server only has the CAR
  profile loaded, so `/route/v1/foot/…` still returned car-speed `duration` (walk ETA == drive ETA). Now for
  `mode==='walking'` we IGNORE OSRM's duration and derive time from road distance at `WALK_KMH=4.8`
  (2.31 km → ~29 min, not 6); driving keeps OSRM's car duration. Note updated to "~4.8 km/h".
Tests: `/tmp/round3_test.cjs` (find/settings/gazette-tab/dashboard-gone/no-emoji/shared-picker — all green) +
`tools/games_test.cjs` (35, 0 flagged) + minify Silk gate. Merged to `main` at the user's request.

## ⚡ Fix: KindleHub keyboard typed to the START of the box (caret reset)
User: "when you pre-type on the KindleHub keyboard… it goes back to the start of the text box." Root cause: the
KB sets the target `readOnly` to suppress the native keyboard, but old Silk reports a readOnly field's
`selectionStart` as **0** AND **ignores the selectionStart setter** — so `typeChar` read position 0 every
keystroke and inserted at the start (typing "hello" → "olleh"). Fix: the keyboard now tracks its OWN caret
(`_caret`, near `_target`) instead of trusting the field's selection API. `_attachToTarget` SEEDS `_caret` from
the tap position on the FIRST attach (read BEFORE `readOnly=true`, gated on `khOrigRo==null`), else the value's
end. `typeChar`/`typeBackspace`/`insertSugg`/`getPrefix` route through `_kbCaret(v)` (clamped) + `_kbSetCaret(pos)`
(updates `_caret`; best-effort field-setter only when NOT readOnly). Test `/tmp/kbcaret_test.cjs` mocks
`selectionStart→0` (the Silk behaviour) and asserts typing "hello" yields "hello", not "olleh". Supersedes the
"typeChar writes value programmatically so readOnly is fine" claim in the earlier double-keyboard note.

## ⚡ Fix: keyboard default = landscape-on-Kindle/off-on-PC + slow Kindle sign-in
- **Keyboard default** (`_kbdWantedNow`, the AUTO case): was `return isKindleBrowser()` (always-on on Kindle).
  Now `return isKindleBrowser()?isLandscape():false` — on a Kindle the on-screen keyboard defaults to
  **landscape only**; on a phone/PC it defaults **off** (they have real keyboards). Explicit modes
  (always/landscape/off) unchanged; legacy `kindleKeyboardManual` path unchanged. Settings card banner +
  the Auto label updated ("Kindle: landscape only · PC: off"). Re-eval already wired to resize/orientationchange.
- **Slow "Signing in…"** (`authLogin`): the two PRE-checks before the real lookup — `_khIsBanned` and
  `_refreshCapacity` — are each a network round-trip that, on flaky Kindle Wi-Fi, could hang for the full 12s
  `_sbFetch` timeout, stacking ~24s+ before the account fetch even starts. Both are now wrapped in a
  `_raceTO(promise,3500)` (Promise.race vs a 3.5s timer, fail-OPEN) so a slow gate can't block a legit login;
  both are ALSO enforced server-side so nothing is weakened. The actual `_sbSelect('kh_users')` lookup keeps
  its 12s bound. (Tested: minify Silk gate + boot regression; login needs a live backend so verified by code.)

## ⚡ Round: de-brand retro masthead + rich Sports app + Farm v3 + image-app resilience
- **Retro masthead not self-advertising** (`uiMode==='simple'` home): the window title bar said "KINDLEHUB"
  and the no-name greeting fell back to "KindleHub". Now the bar reads "HOME" and the fallback greeting is
  "Welcome" (the app-header logo still says KindleHub Pro — only the retro home masthead was de-branded).
- **Sports app rebuilt** (`BUILDERS.sports`): was a flat today-only score list. Now: a **date bar** (Prev /
  day label / Next / Today) hitting `scoreboard?dates=YYYYMMDD` so you can walk **past / live / future** days
  (LIVE badge on in-progress games); every game is **tappable** → a detail view built from
  `summary?event=<id>` with the scoreline, status, venue, then the best-available stat blocks per sport:
  **team-stats comparison** (`boxscore.teams[].statistics`), **soccer lineups + formation** (`rosters[]` incl.
  each side's `formation` and starters/subs), and **US-sport box-score players** (`boxscore.players[]`);
  falls back to `leaders[]`. **Tapping any player** opens their per-game stat line (`_showPlayer`) — the
  requested "click Ronaldo → shots/assists", basketball shows its own stat keys, etc. Avoids Array.find. Test
  `/tmp/sportsfarm_test.cjs`.
- **Farm v3 — "make it actually fun"** (`const Farm`): added a real management/economy loop on top of the
  crop/level/weather/order base — **animals** (`ANIMALS` chicken/cow/pig, level-gated) give **passive coins
  every Next day** (`_animalIncome`); a **Sprinkler** upgrade (`SPRINKLER_COST`, `st.sprinkler`) auto-waters
  every crop each day; a daily **market event** (`MARKET`/`MKEYS`: Steady / Market Day +50% sell / Harvest
  festival coin bonus) via `_sellPrice(c)`; plus a **Harvest-all** button. New S fields (`animals`,`sprinkler`,
  `market`) back-filled by `_norm`. Still turn-based / e-ink-safe.
- **Image app resilience** (`imagesearch` `run`): a user reported it "not working". It now retries via CORS
  proxies on **any** failure — incl. an HTTP error like Openverse's low anonymous rate-limit (429) or a 5xx,
  not just network/CORS — and falls through **two** proxies (allorigins → corsproxy.io) since a proxy fetch is
  a different route. (The other two forwarded reports — old chat messages resurfacing, a sent email
  vanishing — are the message-cache/mail-cap behaviours, noted but not chased blind.)
Tests: `/tmp/sportsfarm_test.cjs` (sports structure + date nav + image build; farm barn/animals/sprinkler/
market buy-flow) + `tools/games_test.cjs` (35, 0 flagged) + minify Silk gate. Merged to `main`.

## ⚡ Round: chat Polls + profile backgrounds (Messages upgrade, no media backend)
User wants a full Messages recreation (images/polls/threads/screenshots/GIFs/apps/profile-backgrounds/friend
requests). Reply/threads (`m.replyTo`+quote), **app sharing** (`KHAPP1:`), and **friend requests** already
exist. This round added the two big pieces that need NO media backend:
- **Polls** (global `_khPollCode`/`_khPollParse`/`_khIsVoteMsg`/`_khPollTally` near `_khAppMsgCard`): a poll
  is a plain `KHPOLL1:`+b64`{pid,q,opts}` message; each vote is a separate `KHVOTE1:<pid>:<optIdx>` message,
  so the append-only encrypted store needs NO mutation — the client tallies from the loaded messages (latest
  vote per user wins). `renderMessages` filters out `KHVOTE1:` bubbles (`_noVotes`) and renders a `KHPOLL1:`
  message via `_renderPollCard` (question + option bars + %/count + tap-to-vote/change; sends votes through
  `_sendPayload`, a draft-free send). Composer `+` menu (was app-only, now "Attach") gains **Create a poll**
  (`_khOpenPollMaker`: question + 2–6 options). Test `/tmp/msg_test.cjs` (encode/parse/tally + hide).
- **Profile backgrounds** (Settings → Profile card): `PROFILE_BGS` gradient banners behind the avatar,
  stored in `S.profileBg`; 4 free + 4 **Ultra/Creator-gated** "premium" (★) via `_khRequireUltra`/`_khTier`.
  A live `#profileBgBanner` + swatch grid; premium taps are blocked for non-Ultra. (Cosmetic + local — sharing
  your background to OTHERS' clients would need a profile-sync channel, deferred.)
- **Still deferred (need an external host/API, honestly told to the user):** sending **images / screenshots**
  (base64 blows the per-message cap → needs an image host upload) and **GIFs** (no reliable keyless GIF API —
  Tenor/Giphy public keys are dead). Everything else the user listed now works.
Tests: `/tmp/msg_test.cjs` (polls + profile-bg + friend/app globals) + `tools/games_test.cjs` (35, 0) + minify
Silk gate. Merged to `main`.

## ⚡ Round: Messages media — inline Images + Screenshots + Sticker pack (the deferred pieces, now shipped)
Delivered what the last round deferred, WITHOUT a media backend — images ride the same E2E-encrypted,
size-capped message path as text (like `KHAPP1:` app codes already do), just hard-downscaled first. Global
helpers live right after the poll helpers (`window._khImgCode` etc.):
- **Images / Screenshots** travel as a `KHIMG1:`+`<jpeg data URL>` message. `_khDownscaleImage(src,maxDim,
  budget)` (canvas) shrinks any source to a JPEG under a **char budget (~12 000)** by stepping quality
  0.6→0.2 then dimension 240→~100px until it fits — a 25 KB PNG → ~8.8 KB JPEG in tests, so it stays under the
  16 KB app-share precedent even after encryption. `_khImgParse`/`_khIsImgMsg`; render = `_renderImgCard`
  (thumbnail, tap → `_khOpenImageViewer` fullscreen). NB canvas JPEG encode works on Silk (same `toDataURL`
  the screenshot app uses); if an engine returns PNG instead, the budget check fails gracefully → a toast.
- **Screenshots** reuse the app's own `window._khShots` (html2canvas data URLs) — the attach picker shows a
  "Capture this page now" button + a thumbnail grid of recent shots, each downscaled before send. No new
  capture code.
- **Stickers = the honest "GIFs" answer** (`_KH_STICKERS`, 12 built-in **inline-SVG** in `currentColor`):
  travel as a tiny `KHSTK1:<id>` (just an id — ~zero bytes/wire, instant, never animates so it can't lag on
  e-ink; real animated-GIF search needs a Tenor/Giphy key AND animates terribly on e-ink). `_khStickerParse`
  validates the id against the fixed pack; render = `_renderStickerCard` (92px SVG). Pack: like/love/smile/
  haha/wow/sad/fire/yes/no/star/party/100.
- **Composer `+` "Attach" sheet** (`_khOpenAppShareMenu`) now leads with **Image** (`_khPickAndSendImage`,
  hidden file input), **Screenshot** (`_khOpenScreenshotPicker`), **Sticker** (`_khOpenStickerPicker`, 4-col
  grid), then Poll + app list. Grids use explicit heights (NOT `aspect-ratio`, unsupported on old Silk).
- **No raw codes leak into text surfaces**: `_khMediaLabel(text)` → `[Image]`/`[Sticker · X]`; wired into
  `notifyMsg` (toast/notification body) and a closure `_msgPreview()` used by the reply-quote + reply-strip.
  The render dispatch (55999) gained `else if(_imgUrl)`/`else if(_stkId)` branches before the poll branch.
- Send path unchanged: media goes through `_sendPayload`/`sendMessage`→`_groupSend` as a normal (encrypted)
  message; `renderMessages` decodes the prefix. So it works over the existing D1/Supabase transport, no worker
  or schema change.
Tests: `/tmp/media_test.cjs` (codec/label/downscale-to-budget, 12 stickers) + `/tmp/media_integ_test.cjs`
(opens a real chat, sends a sticker + image via the composer, asserts `<svg>`/`<img>` bubbles + no raw code +
the Attach sheet's 3 media rows + sticker grid) + `/tmp/msg_test.cjs` (polls/profile-bg still pass) +
`tools/games_test.cjs` (35, 0) + minify Silk gate. So the FULL Messages request (images/polls/threads/
screenshots/stickers/apps/profile-bg/friends) is now delivered. Remaining honest gap: **live animated GIF
search** (still needs a Tenor/Giphy key) and **cross-device profile-background display** (needs a profile-sync
channel) — both offered to the user as opt-in follow-ups.

## ⚡ Round: finish the PENDING todo list (streak fix, cross-device profile bg, platformer, games, online play)
Working through the documented "PENDING / bigger jobs" list, each a tested+committed batch on
`claude/keen-tesla-n73rpc` (restarted from `main` after PR #35 merged):
- **Non-UTC streak date-keys FIXED** (was: habits/notes/daily-goal keyed the day off UTC `toISOString().slice(
  0,10)` → a habit ticked at 8pm in New York recorded under tomorrow's UTC date and broke the streak). New
  global helper **`_localDayKey(t)`** right after `NOW()` — returns LOCAL `YYYY-MM-DD` from `getFullYear/Month/
  Date` (clock-offset aware via NOW()). Repointed: habits `todayKey`/`calcStreak`/`thirtyDayRate`/week-dots/
  30-day heatmap, the home **daily-goal** streak (`_today`+yesterday-carry), the Sheets `TODAY()` formula, and
  the calendar event date-input default. LEFT as UTC (correct — they match SERVER date buckets or are benign):
  shared-API daily cap (`readSharedKeyUsage`/proxy), admin stats `isoDaysAgo`, `kh_visit_last_day` throttle,
  announcement date, and **Ultra accrual** (`_ultraDayStr`+cutoffs — internally consistent, gates premium, not
  worth the risk). Notes streak `_currentDailyStreak` + global `todayKey()` were ALREADY local (`toDateString()`/
  local parts). Test `/tmp/streak_test.cjs` (runs in America/New_York; asserts an instant that's next-day in UTC
  keys to the LOCAL day).
- **Pixel Hop — a real Mario-style platformer** (`const Platformer`, game #36, id `platformer`): the "dedicated
  platformer" the user asked for (DigQuest is a dig-and-smash; this is a clean run-and-jump). LEFT/RIGHT/JUMP
  (hold ◄/► buttons + tap Jump, arrow keys/Space, or tap the canvas one-handed). Hand-authored beatable level
  (`PLATS` ground+floaters with ≤70px pits, `COIN_DEF`, `ENEMY_DEF` patrollers), AABB collision (move-X-resolve
  then move-Y-resolve), **jump BUFFER + COYOTE time** (`JBUF`/`COY`, the DigQuest feel-fix), stomp-from-above
  vs side-hurt enemies, coin rings, a goal flag, 3 lives with **auto ledge-checkpoints** (`g.safe` updated each
  grounded tick → respawn there on pit/hit). ~30fps `setInterval`, flat fills, guarded HUD writes (e-ink-safe),
  `stop()` no-op guard. Wired at ALL points: `_doLaunch` case + **added to the exitImmersive stop-list**
  (bare `Platformer` ref, safe — it's a normally-initialised const, not lazy like `window.CandyCrush`) +
  `GAME_HELP` + `GAME_MAP` + a `gc('Pixel Hop',…data-game=platformer)` card in rowArc + `tools/games_test.cjs`
  (now 36 games, 0 flagged). Score = coins×10 + stomps×20 + 150 finish bonus → `S.games.platformer.best` +
  `_khSubmitScore`. Test `/tmp/platformer_test.cjs` (drives ►+jump: % climbs 4→23, coins collected, lives shown,
  clean exit with no leaked interval).
- **Flashcard review polish** (Tools parity): the SRS was already strong (SM-2 due scheduling + Again/Hard/Easy
  + 4 study modes Flashcard/MC/Written/Spell + CSV import + AI-from-notes). Added the two real gaps: (1)
  **Cram mode** — `studySR(di,cram)` now takes a cram flag that reviews the WHOLE deck shuffled, ignoring the
  due schedule (fixes the dead-end where a deck with nothing due just toasted "come back later"); a **Cram all**
  button sits next to SRS Review in `renderDeckList`, and the session-complete screen shows a "Cram again" /
  "Review again" button + how many are still due. (2) **Keyboard shortcuts** — Space/Enter flips, 1/2/3 =
  Again/Hard/Easy (handlers stashed in `curShow`/`curRate`, swapped per card); the front card is also
  tap-to-flip. The keydown listener is removed via `immersiveRoot._trackStop=cleanup` (exitImmersive) AND on
  session-complete, so no leak. Rating still updates the SRS schedule in cram mode (reinforcement). Test
  `/tmp/flash_test.cjs` (0 due → cram runs all 3, Space flips, key-3 rates, completes, schedule advanced, no
  stray handler after exit).
- **Two new e-ink games from the "feasible-but-missing" list** (now 38 games, `tools/games_test.cjs` 0 flagged):
  - **Maze** (`const Maze`, id `maze`): recursive-backtracker maze; navigate top-left → ★ bottom-right via
    D-pad / arrow keys / swipe; solving advances a slightly larger level. Static board (only the player dot
    moves) + a 1s clock — no render loop, e-ink-perfect. Best level → `S.games.maze.best`.
  - **Perfect Circle** (`const PerfectCircle`, id `perfectcircle`): drag one stroke; on release it's scored
    0–100% on roundness (radius stddev/mean + closure penalty, no Math.hypot — Silk-safe sqrt). Draws the ideal
    circle overlay + score. Best → `S.games.perfectcircle.best`.
  Both wired at ALL points (`_doLaunch`, exitImmersive stop-list, GAME_HELP, GAME_MAP, rowArc cards, games_test).
  Test `/tmp/maze_circle_test.cjs` (maze drives + New-maze + clean exit; a traced circle scores 98%, best saved).
  Remaining from that batch (optional, not started): Nerdle, Yahtzee, Dino (GeometryDash reskin), Connections,
  Spelling Bee, Strands, Mini Crossword.

- **Weekly staggered auto-compress** (`_maybeWeeklyCompress`, fired ~30s after load): re-packs each synced
  account into the compact gzip form and pushes one compressed re-sync ~once a week — NORMAL compress only,
  never the data-pruning supercompress (that stays reserved for a real out-of-space emergency,
  `_emergencyFreeSpace`). Each account is pinned to ONE day of a 7-day cycle via `hash(userId)%7`, so only
  ~1/7 of users re-sync on any given day (verified ~14% max) — no daily write spike. Skips when offline or
  while `_khCfBlocked(true)` (a CF limit is active). `localStorage['kh_last_autocompress']` is the per-device
  guard. The cloud blob is ALREADY dictionary+gzip compressed on every normal sync (inside `_encryptState`),
  so this just guarantees periodic compaction without bloat.
- **Admin MESSAGES / per-user message counts are LIVE `_sbCount` queries**, never a stored cumulative tally —
  nothing persists "every message ever sent", so the number only reflects rows currently in the cloud
  (bounded by groups×cap). No counter to grow, no extra storage.

## ⚡ Round: user bug batch — reserved name, fast sign-in, image 403, sticker/theming/location/display-name
Seven fixes from live user reports, all on `claude/keen-tesla-n73rpc`:
- **Reserved "aran" for NEW sign-ups** (`_reservedUsername`, near `_badUsername`): a register-ONLY gate (kept
  SEPARATE from `_badUsername` because that word list also drives display censorship — a reserved brand word must
  NOT be blacked-out in chat). Leet-normalised so "4ran"/"@ran"/"a.r.a.n" are caught. `authRegister` rejects a
  match BEFORE any network; existing accounts (incl. the admin's own `aran…`) still sign in (login untouched).
  Usernames are hashed client-side so the server never sees them — necessarily a client gate.
- **Sign-in slow, sign-up instant** (`authLogin`): the asymmetry was login downloading + decrypting the FULL
  state blob over Kindle Wi-Fi (heavy account) while a fresh sign-up makes an empty state. Added an
  **offline-first FAST PATH**: if this device holds an encrypted copy for the exact key, decrypt locally and sign
  in IMMEDIATELY, then reconcile with the cloud in the background via `_maybePullFromCloud` (password still
  decrypts the local copy → no bypass; stale copies merge forward). The two pre-check gates
  (`_khIsBanned`/`_refreshCapacity`) now run CONCURRENTLY (`Promise.all`, 2.5s box) instead of 2×3.5s. First
  sign-in on a NEW device still does the full network load.
- **Image app 403** (`imagesearch` `run`): Openverse hard-403'd even through the CORS proxies. Rebuilt as
  MULTI-SOURCE: **Wikimedia Commons** (real keyless search, `origin=*`, reliable) primary → Openverse(+proxies)
  backup → **Picsum** (the source the Slides app uses — keyless, never 403s) guaranteed fallback so it's never a
  dead screen (labelled "sample images"). Normalised to `{thumbnail,url,title,creator,license,foreign_landing_url}`.
- **Sticker = black box on the SENDER's own bubble** (`_renderStickerCard`): forced `color:var(--fg)` (dark) but
  the own bubble is `--accent` bg + `--accent-inv` (light) text → dark-on-dark invisible. Now `color:inherit`.
- **Colour theming REMOVED from Settings** (user request): deleted BOTH accent-swatch pickers (`apCard` + `c2`)
  and made `applyCustomisation` ALWAYS `removeProperty('--accent')` (never apply `S.accent`) → every account
  reverts to each theme's built-in monochrome (`--accent===--fg`). `S.accent`/`KH_ACCENTS` left inert; font
  picker kept.
- **Message location "not recorded"** (`_groupSend`): a prior change dropped the client `location_hint` send and
  relied on SERVER-side stamping — only the D1 worker does that (empty on Supabase/no edge geo). Restored the
  best-effort client label (`_khCachedLocationLabel`, cached once/session) as a FALLBACK; the D1 worker still
  OVERRIDES with trusted `request.cf` geo (spoof-proof there, works everywhere else).
- **"Displays as qwerty to everyone but me"** (`displayName`): signed-in name was `S.email.split('@')[0]` and own
  messages never show the author line, so users never saw their own name; the Profile "Save Name" field wrote
  `S.user` which `displayName()` ignored. Fixed: `displayName()` prefers a new editable **`S.profileName`**; the
  Profile field is relabelled **Display name**, PREFILLED with what others currently see, profanity-checked, and
  its (previously unwired) Save button writes `S.profileName`.
Tests: `/tmp/fixbatch_test.cjs` + `/tmp/acc_check.cjs` (accent picker gone) + minify Silk gate.

## ⚡ Round: pool 2-player (local + online), flight-sim 3 planes, creator links
- **8-Ball pool: 1P / 2P / Online modes** (`const EightBall` rewrite). Launch now shows a MODE MENU (`showMenu`)
  → `beginGame(mode,session,oppName)`. **Local 2-player** (`local2`): turn-based on one device — sink a ball to
  shoot again; miss OR scratch passes the turn; a turn/score HUD (`ebHud`, `updateHud`); the **8-ball must be
  sunk LAST** (`resolveShot`: sink it with all your balls gone + no scratch → WIN; sink it early / with a scratch
  → LOSE). Per-shot flags (`sankThisShot`/`scratchThisShot`/`eightThisShot`) set in the pocket loop; a shot
  "settles" when `game.shooting && allStopped()` → `resolveShot`. **Online** (`online`, Ultra-gated automatically
  by `KH_MP.openLobby`): host=white=index0 breaks first, guest=black=index1. **Shooter-authoritative sync** —
  only the current shooter simulates; when the balls settle it broadcasts the full settled state
  (`{t:'ST',b:_serialize(),tn,sc,ov,wn}`) via `KH_MP.send`; the opponent `_adopt`s it (snap), so there are NO
  physics-determinism/drift problems and no per-frame bandwidth. `KH_MP.subscribe` (its built-in 3s poll works on
  the D1 gateway) delivers moves; `onNet` ignores our own echoed messages by userId and re-broadcasts state on a
  guest `JOIN`. `_down` blocks aiming when it isn't your turn. Solo mode is unchanged (best score + submit). Help
  + games-grid card updated; `tools/games_test.cjs` still 0/38 (launch now opens the menu). Test
  `/tmp/pool_test.cjs` (menu 3 modes; 2P board+HUD; a miss passes the turn to Player 2; online option Ultra-gated,
  no crash).
- **Flight Sim description fixed** (`GAME_HELP.flightsim` + the games-grid card): said "Cessna 172" but there are
  THREE aircraft (`AIRCRAFT`: Cessna 172, Piper Arrow, King Air 90). Now names all three / says "pick from 3".
- **"Also by the creator" card** (`cAlso`, Settings): added the missing **DungeonQuest3D** link
  (`https://dungeonquest3d.pages.dev`, was name-only, no button) + three new base44 projects — **Chem Ultra AI**
  (`chem-ultra-ai-aran.base44.app`), **Math Master Pro** (`math-master-pro-aran.base44.app`), **Neural Lab**
  (`neural-lab-aran.base44.app`). All open via the scheme-safe `_khOpenExt`.

## ⚡ Round: Pixel Hop one-tap directional jumps + retro masthead removed
- **Pixel Hop directional jump buttons** (`Platformer` `jumpDir(dir)` + a new control row): Kindle e-ink has no
  reliable multitouch, so holding ◄/► AND tapping Jump at once is awkward. Added one-tap **Jump ◄** / **Jump ►**
  buttons — `jumpDir` sets `game.jbuf` (buffered jump) AND briefly holds that direction (`game.right/left=true`,
  released after 430ms) so a single tap both jumps and carries you that way. The hold ◄/► + Jump controls stay.
  Test `/tmp/hop_mast_test.cjs` (Jump ► taps advance 2%→16%).
- **Retro "HOME / date / Hello, <name>" masthead REMOVED** (`uiMode==='simple'` home): the whole
  `.simple-masthead` block (the `smh-bar` title bar + `smh-title` greeting + `smh-sub` "Good morning · <weekday>")
  is gone — the retro home now opens straight into the featured row. The `.simple-masthead` CSS is left unused.

## ⚡ Round: Animals app + Explore hub + bug batch (clipboard/removeChild/announcement/calendar/poll)
- **Animals encyclopedia** (`BUILDERS.animals`, nav tab + `['animals','Animals']`): a zoo field guide. 7 class
  tabs (Mammals/Birds/Reptiles/Amphibians/Fish/Invertebrates/Insects) + search; tap an animal → a stat page:
  live Wikimedia-Commons images (`fetchImgs`, keyless `origin=*`), a stat grid (Length/Weight/Speed/Lifespan/
  Location/Diet), a **size-vs-human** SVG bar (`sizeSvg`, `size:[m,'tall'|'long']`), a long description, FUN
  FACTS / JOKE / GOOD-TO-KNOW blocks. Curated `DB` of ~36 animals (offline-safe; only images need network).
  In-view list⇄detail nav. Test `/tmp/animals_test.cjs`.
- **Explore hub** (`BUILDERS.explore`, nav tab): cards linking Animals, Stars, Science, Wikipedia, Weather,
  Elements, Images, Sports — the "look things up" apps grouped in one place (per the user's "put stars into it").
- **Kindle clipboard fix** (`isKindleBrowser` shim IIFE): old Silk REJECTS `navigator.clipboard.writeText`
  ("Write permission denied"), so every Copy button failed + the rejection was auto-reported as a crash. On
  Kindle we now REPLACE `navigator.clipboard.writeText` with a legacy `execCommand('copy')` path (hidden
  textarea + select) — fixes ALL copy buttons at once, no per-site edits. Non-Kindle keeps the real API.
- **removeChild NotFoundError** (Worker-setup dialog + 2 siblings): `document.body.removeChild(ov)` threw when
  the overlay was already gone OR was mounted on `rotateRoot` (landscape) not `body`. Switched to the safe
  `ov.remove()` / `d.remove()` (guarded).
- **Announcement comment 403** (`_openCommentThread` post): on Supabase the RLS refuses a client PATCH of
  kh_announcements ("update not allowed", 403) — comments need the D1 backend. Replaced the `console.error`
  (which was auto-reported as a crash) with a graceful toast; no functional change on D1 where it works.
- **Calendar "delete all → Sync → they all come back"** (tombstone coverage, `_khTrackDeletions`/
  `_khGcTombstones`): two gaps — (1) `window._khPrevIds` wasn't seeded until the session's first save(), so a
  bulk delete before that recorded NO tombstones → cloud-merge resurrected everything; now seeded ONCE at boot
  right after S loads. (2) the tombstone cap (2000) couldn't hold ~4,000 deletions → raised to **8000** (keeps
  newest). Test `/tmp/bugbatch2_test.cjs`.
- **Poll option labels invisible on your own bubble** (`_renderPollCard`): same class as the sticker bug — the
  option ROWS have a light `--card` background but the label inherited the own-bubble's light `--accent-inv`
  text = invisible. Forced `color:var(--fg)` on each option row; the POLL label + footer now inherit the bubble
  colour (opacity .7) instead of the dark `--accent`.
Tests: `/tmp/animals_test.cjs`, `/tmp/bugbatch2_test.cjs`, `/tmp/msg_test.cjs`, `tools/games_test.cjs` (38, 0),
minify Silk gate.

## ⚡ Round: REAL App Store (marketplace + publish-with-AI-review + migration; removed tab pickers)
The big "make the app store real" request. A genuine Apple-App-Store-style marketplace (a NEW app — does NOT
replace the KindleOS AI app builder), all on `claude/keen-tesla-n73rpc`. Store apps are NOT in index.html as
extra views-per-app; the first-party ones are existing BUILDERS the store just installs/uninstalls into the
nav, and user-published apps live in `S.publishedApps` (device/account state, sandboxed iframe) — never in the
site code, exactly as the user asked ("downloadable to the html of the user's localStorage/account session").
- **Global helpers** (inserted after `window._reservedUsername=…`, ~line 8036, all `window.`-exported):
  `STORE_APPS` (16 first-party: Slides/Sheets/To-Do Board/Animals/Stars/Elements/Formulas/Wikipedia/Science/
  Cipher/QR/Teleprompter/Draw/Cookbook/Sleep/Stocks, grouped by category), `STORE_DEFAULT_MOVED` (the 12 hidden
  from nav by default on first run), `_khOtherStorePages()` (synthesises store cards for EVERY other NAV_TABS
  view not already a store app + not permanent home/settings/appstore → a **"More Pages"** category, so now that
  the Settings tab-picker is gone NOTHING a user hid can get stranded — the store is the single tab manager).
  Install model reuses `S.navHidden`: `_khStoreInstalled(v)` = `navHidden[v]!==true`; `_khStoreInstall/Remove(v)`
  toggle navHidden + `setNavTabVisible`. `_khStoreMigrate()` one-time (guarded by `S.appStoreMigrated`; only sets
  `navHidden[v]=true` when it was `==null`, so explicit user choices are respected) + a boot IIFE that runs it,
  applies `setNavTabVisible(false)` to moved apps, shows `_khMaybeShowStoreNotice()` once
  (`localStorage['kh_appstore_seen']`, the in-app "the App Store is here" announcement), and kicks the review
  queue.
- **Publish + AI review** (`APP_REVIEW_MODELS=['gemini-3.5-flash','gemini-3.1-flash-lite','gemini-2.5-flash']` —
  ONLY these 3 are trusted to review, strongest-first, per the user). `_khReviewApp(name,html)`: tries each
  model, 3 attempts each with `1200*attempt` backoff (handles the "busy / ~5-min limit → auto-retry" cases);
  parses a STRICT-JSON approve/decline verdict via `_khParseVerdict` (JSON first, keyword fallback); the model
  can ONLY approve or decline, never edit. If EVERY model is unavailable → `{waitlisted:true}`. `_khPublishApp`:
  validates (≥20 chars, ≤512 KB, clean name), reviews, then approve→`S.publishedApps.unshift` (cap 60) /
  decline→toast reason / waitlist→`S.appReviewQueue` ("waiting list for the next day"). `isGame` auto-derives
  from `cat==='Games'`. `_khProcessReviewQueue(force)`: throttled (~20 min via `kh_review_queue_last`, or forced
  by a "Check review queue now" button) re-review of queued apps — approve→publish+toast, decline→drop+toast,
  still-no-model→stay queued; offline (`navigator.onLine===false`) leaves everything queued. Runs ~6 s after
  boot and (throttled) when My Apps opens — so a daily-quota app clears itself once a model frees up. `khiCall`
  uses the user's Gemini key if set else the always-on `shared` proxy (so the guard is offline-only, NOT
  khiEnabled — that was a bug that blocked shared-proxy users; fixed).
- **`BUILDERS.appstore`** (before `qrgen:`): Discover / Publish / My Apps tabs. Discover = search + first-party
  apps + "More Pages" grouped by category with Get/Open/Remove + a Community section (published apps, sandboxed
  Open). Publish = name + category chips (Fun/Games/Tools/Productivity/Creativity/Other) + an HTML textarea +
  "Build with AI" (khiCall) + Publish → `_khPublishApp` with live status. My Apps = review-queue list + "Check
  review queue now" + your published apps (Open/Delete). `_khOpenPublishedApp` = sandboxed iframe overlay
  (`sandbox="allow-scripts allow-forms allow-popups allow-modals"`, no same-origin — can't reach our storage).
- **Games page gets published games** ("add extra games to the games page"): a **Community Games** section at the
  bottom of `BUILDERS.games` lists `S.publishedApps` where `isGame||cat==='Games'` (Play → sandboxed iframe) + a
  "Publish a game" button → the store. Empty-state explains the flow.
- **OS + normal mode**: nav HTML `<div class="tab" data-view="appstore">` + `NAV_TABS ['appstore','App Store']`
  (never hidden — not in STORE_APPS/moved) + `BUILTIN_APPS {id:'appstore',nav:'appstore',color:#0b7ff2, store-A
  SVG icon}` so it's on the KindleOS home grid too. `S` defaults gain `publishedApps:[]`/`appReviewQueue:[]`.
- **Removed the two tab pickers** (user: "remove the tabs in the header selection in settings and setup
  wizard"): the Settings **"Top Menu Pages"** card (the whole `cNav` block in `_defer`) and the onboarding
  **"Your tabs"** step (`id:'nav'` in `_showWelcome`'s STEPS) are deleted — the App Store is the single place to
  manage the menu now. ("adding seconds to the clock" was read as an illustrative example of the store's scope,
  not a literal toggle — the header is date-only.)
Tests: `/tmp/appstore_test.cjs` (migration hides moved apps; view+3 tabs; Get installs; verdict parse; publish
approve/decline/waitlist; queue processor drains→publishes; Community Games shows a published game — all green) +
`/tmp/appstore_boot.cjs` (fresh-load: notice shows+dismisses, appstore mounts, no pageerrors) + games_test (38,
0) + fixbatch/acc_check (settings still builds, accent picker still gone) + minify Silk gate. NB: users are
notified of the change via the one-time in-app notice (`_khMaybeShowStoreNotice`); a live backend announcement
would have to be posted by the admin (I can't write to their cloud).

## ⚠ Minified deploy build (`index.min.html`)
- **`index.html` = readable source you EDIT. `index.min.html` = generated deploy artifact you UPLOAD.**
- After ANY edit to `index.html`, regenerate: `cd tools && npm install && node minify.mjs` (writes
  `../index.min.html`). Commit both. The minifier (`tools/minify.mjs`) extracts each real `<script>`/`<style>`
  block (a tiny scanner that skips `<!-- -->` comments — needed because `<script>` appears as text in HTML
  comments AND in JS template literals, which breaks every off-the-shelf HTML minifier) and minifies bodies
  with terser (`compress:false, mangle:false` — comments+whitespace ONLY, so cross-`<script>` globals + inline
  `onclick` can't break) + clean-css L1. Validate after: load `index.min.html` headless, build all views,
  check no pageerrors. NEVER hand-edit `index.min.html`.


## Feature status
DONE: Mail (internal + external via worker, KHI summarise/draft/polish, folders, search, avatars),
Recent-activities switcher
(header "Recent" button = lightweight "minimise/jump between activities"), landscape mode v2 (rotates
`#rotateRoot` 90° — but ONLY when the viewport is portrait; on a wider-than-tall screen, e.g. a laptop,
`toggleLandscape` skips the rotation instead of turning everything sideways),
offline login + username prefill, website shortcuts (browser New-Tab), Contributors card, Ultra progress,
admin Local Insights, Team Sudoku (share/load puzzle code), Flight Sim "How to fly", profile avatar+status,
feedback 7-day auto-prune, app-maker double-install guard,
Free Library (in-app Project Gutenberg reader — search + read full text, paginated, resume position, font
size; wired to the books tracker. Closes the one gap vs **ReKindle** — rekindle.ink, the competitor users
compare us to: it can read free Gutenberg/Libby books; we now read full text too AND keep everything else).

Split screen / "2 pages in 1" multitasking — two stacked, independently-scrolling panes, each a real view;
entry via the repurposed header "Recent" button (now the `_khOpenMultitask` panel). Delivered the community
"multitasking" request; the heavier "true N-tab background multitasking incl. KindleOS" is still pending.

Cloudflare R2 state gateway (zero-egress cloud sync, `state-worker.js`) + Capacity Guard (admin emergency
sign-in lock with auto-expiring "back on <date>" message) — the permanent fix for the Supabase egress cap.
Geometry Dash ("Stereo Madness" one-button rhythm runner, 30th game).

Games gap vs **ReKindle**'s grid: we already have most of it (Codebreaker=Mastermind, Uno=Crazy Eights) PLUS
games they lack (Slither, Space Invaders, Flight Sim, Tower Defence, Turbo Racer, DigQuest, Geometry Dash).
Feasible-but-missing batch to add (all e-ink-friendly): Anagrams, Connections, Spelling Bee, Strands, Nerdle,
Mini Crossword, Nonograms, Maze, Yahtzee, Perfect Circle, Dino (reskin of the GeometryDash engine). SKIP on
e-ink: DOOM (fast raycaster), Pictionary-LIVE (realtime drawing — revisit if Durable Objects realtime lands).

PENDING / bigger jobs (each its own session):
- **True N-tab background multitasking** (keep 3+ activities alive at once, incl. KindleOS). Split screen
  covers 2 side-by-side; this is the heavier multi-tab version.
- **Online real-time 2-player games** to beat ReKindle: our chess/checkers/connect4/battleship are local
  pass-and-play (same as ReKindle). Live cross-device play (Supabase realtime/polling + matchmaking) would
  pull ahead. Big, its own session — requested alongside the reader but deferred to avoid bundling risk.
- **Tools/productivity parity+** vs ReKindle's Tools tab: Pomodoro/focus timer, flashcard review polish.
- **Dedicated platformer game** — note: **DigQuest already IS a platformer** (`const DigQuest`), described
  as a 2.5D dig-and-smash story platformer. A new cleaner Mario-style platformer was requested.
- **Online real-time team games** (live shared board for 3–4 players). Team Sudoku is share-a-code only.
- Non-UTC streak date-keys (habits/notes use UTC `toISOString().slice(0,10)` — wrong rollover off-UTC).

## Known gotchas
- **⚠ Old-WebKit (Kindle Silk) syntax — modern Chromium/headless WON'T catch it.** Silk throws a
  SyntaxError on ES2020+ syntax and that kills the WHOLE script/app. BANNED in any code that runs on
  Kindle (incl. code-snippet TEMPLATE strings and AI-generated apps): optional chaining `?.`, nullish
  coalescing `??`, logical-assignment `||= &&= ??=`, numeric separators `1_000`, parameterless `catch{}`,
  regex lookbehind `(?<=)`/named-groups `(?<name>)`/`\p{}`/`s`,`y`,`d` flags. async/await + object spread
  are fine (Silk supports them). The deploy gate: `tools/minify.mjs` runs an **OLD-WEBKIT SYNTAX GATE** on
  the minified output (raw-text scan so it catches operators even inside template strings — an AST parse
  misses those) and FAILS the build (non-zero exit, nothing written) on a hit. Heuristics need an
  expression-ending char before the operator so the placeholder string `'??'`, regex `\??`, and ternaries
  don't false-positive — and when you WRITE about these operators in a prompt/comment, name them in words,
  don't spell the literal sequence (it'll trip the gate). This class once shipped via the `localStorage`
  code-snippet template (`??`+`catch{}`) → "syntax error only on Kindle, line 1:282" (the position was
  inside the generated app, not the bundle).
- **AI app SAFETY GUARD** (`_khSilkScan`/`_khSilkAutofix`/`_khCallActiveAI` in the KindleOS app builder):
  after the model returns an app, we auto-bind `catch{}`→`catch(_e){`, then if `?.`/`??`/etc. remain we
  ask the model ONCE to repair, then show a "may crash on Kindle" preview note if still unsafe. The
  builder system prompt (rule 8 in the CRITICAL KINDLE WEBKIT COMPATIBILITY RULES) also bans these by
  name. AI-app + AI-preview iframes are `sandbox="allow-scripts allow-forms allow-popups allow-modals"`
  (no `allow-same-origin`) so generated code can't reach our localStorage/auth.
- Editing `index.html` desyncs the editor's file-state after a `sed` write — Read again before Edit.
- Line numbers shift constantly; when wiring by line, grep the exact module/anchor first (a past batch
  mis-wired Snake/2048 new-game guards because line numbers moved between grep and edit).
- e-ink: guard text writes with `if(el.textContent!==v)el.textContent=v` to avoid flashes (clocks do this).
- e-ink perf: a per-second `setInterval` must NOT `innerHTML=''`+rebuild a list every tick — that's a full
  flash + GC churn each second. Build the structure once, then tick ONLY the changing text (guarded). World
  Clock is the canonical example: `renderClocks()` builds cards into the in-scope `grid` ref (works while the
  view is still detached during build — using `document.getElementById` there silently no-ops and caused a 1s
  empty-grid flash on entry); `tickClocks()` updates just the time/date text. The home countdown widget
  (`renderCd`/`tickCd`) now follows the same build-once + tick-text pattern.
- Per-keystroke `oninput` that re-renders a list = laggy e-ink typing — wrap in `khDebounce(fn,~200)` (RSS
  headline search, science glossary `paint`, Sheets Find now do). Leave live single-cell edits / word-counters
  un-debounced (instant feedback, cheap).
- Don't store non-serializable things in S (functions/DOM) — JSON.stringify in save() would throw and
  (previously) be misread as "storage full". `save()` now only treats real QuotaExceededError as full.
- Storage-full false alarm (admin/large state): `_persistState` writes the RAW json to localStorage first
  (fast path), which on a ~5 MB Mac browser threw QuotaExceededError on EVERY save and flashed "Storage is
  full" even though the COMPRESSED blob fits. Fix: on a raw-write quota error, `_persistCompressed()` stores
  the gzip-packed form instead; the banner (`_checkStorageHealth(true)`) now only fires if even the compressed
  write fails (genuinely out of space).
- Storage-full on EVERY chat message (real out-of-space): the hidden hog is `kh_offline_cred` — it cached up to
  3 whole encrypted state blobs (each ~the main blob's size), so a heavy account overflowed the ~5 MB
  localStorage and the MAIN blob's write failed every save. Fixes: cap offline-cred at 2 (and self-trim to 1
  on its own quota error), and `_persistCompressed` now AUTO-RECOVERS once via `_emergencyFreeSpace()` (trim
  offline-cred to the newest 1 + drop regenerable caches + trim chat history) and retries the write before
  nagging. So the banner only shows if it's still full after auto-freeing. `_dataUsageBytes()` only measures
  the SK blob, NOT total localStorage — that's why the over-budget meter looked fine while writes failed.
- Storage-full banner STILL nagging a heavy SIGNED-IN user: a localStorage write failure is NOT data loss when
  synced+online — the state is in the cloud (12 MB cap >> ~5 MB localStorage). `_checkStorageHealth(fromError)`
  now suppresses the banner entirely for `S.authToken && S.syncEnabled && navigator.onLine!==false` (and just
  triggers `scheduleCloudSync(true)`); only LOCAL-ONLY or OFFLINE users — who'd really lose data — still see it.
