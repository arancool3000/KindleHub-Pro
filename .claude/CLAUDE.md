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

## Account upkeep / staying under Cloudflare limits
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
