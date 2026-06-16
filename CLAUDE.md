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
- Commit when the user asks; branch is `claude/wonderful-clarke-6hm5ex`. The user merges PRs (or asks me to).
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
- **Free Library / reader**: `window.khOpenBookReader(meta)` + `window.khGutenSearch(q)` (defined right after the
  `el()/txt()` helpers). Search = Gutendex JSON (CORS-open); book text via gutenberg.org through the
  allorigins/corsproxy fallbacks (no CORS header on gutenberg). Full-screen `#kh-reader` overlay paginates
  cleaned text (~1700 chars/page), saves position onto the matching `S.books` entry (`gutenbergId/readerPos/
  readerPages`). **Book text is cached in-memory only — never written to S** (a novel >1 MB would blow the
  gzip'd state quota). UI entry = the "Free Library" card at the top of `BUILDERS.reading`, plus Read/Continue
  buttons in `renderBooks`.
- **Games**: each is an IIFE module (`const Hangman=(()=>{…})()`), launched via `launchGame(id)` → `_doLaunch`.
  Immersive overlay (`enterImmersive`/`exitImmersive`, `#immersiveRoot`). Some lazy-init via `_initX()`.
  `newGameGuard(activeFn,start)` wraps "New Game" buttons to confirm mid-game.
- **KindleOS launcher**: `launchKindleDesktop()`, `openApp(app)` (built-in nav OR `customHTML` iframe overlay
  `#kd-customapp`), `closeApp()`. Custom AI-built apps in `osState.customApps`. KindleOS has its OWN tour
  (`startKindleOSTour`); the App-mode guided tour (`_showTutorial`) is suppressed while KindleOS is mounted.
- **Backend (Supabase REST)**: helpers `_sbSelect/_sbInsert/_sbUpsert/_sbUpdate/_sbDelete`, `_sbActive()`.
  Tables: kh_users, kh_groups, kh_messages, kh_mail, kh_feedback, kh_errors, kh_scores, kh_announcements,
  kh_presence, kh_shared_api_usage, kh_banned_usernames, kh_rate.
- **Auth**: `authRegister/authLogin/authLogout`. Hash = SHA-256(username+password) = lookup key AND AES key.
  Offline login via `_cacheOfflineCred`/`_offlineCred` (encrypted blob cached on device, `kh_offline_cred`).
- **Moderation**: profanity filter `_censorText`/`_hasProfanity` (DISPLAY-side only, used in chat, feedback
  AND notification toasts via `notifyMsg`) — two passes: exact word-boundary (`_PROFANITY_WORDS`) + embedded
  roots (`_PROFANITY_SUBSTR`, leet-normalised, guarded by the `_PROFANITY_SAFE` allow-list to dodge the
  Scunthorpe problem). Actions: `_khBanUsername`/`_khUnbanUsername` (kh_banned_usernames RPC) and
  `_khWarnUsername(name)` — a lighter warning delivered as a PRIVATE targeted announcement (no new schema).
  Admin surfaces: the chat "Admin About" modal (`_openUserAboutModal`) and the feedback review of
  `[USERNAME]` reports (which are user ban-requests, stored in kh_feedback) — both have Warn + Ban.
- **Encryption**: `_encryptState/_decryptState` (user state), `_msgEncrypt/_msgDecrypt` (chat & mail).
- **AI**: `khiCall(prompt,opts)` (user's Gemini/OpenRouter key), `khiEnabled()`. Shared-key proxy too.

## Supabase storage/bandwidth (78+ users — keep this in mind)
- **Egress** was the big cost; fixed by `_groupLatestId` probe before pulling chat bodies, and the
  cloud pull checking `updated_at` before downloading the big state blob.
- **Storage** capped via triggers (in BOTH schema.sql and the in-app admin SQL — re-run schema to apply):
  kh_messages 50/group, kh_mail 60/recipient, kh_errors ~600 global. kh_feedback done/ignored items
  auto-prune after 7 days (needs `status_at` column + `kh_feedback_delete` policy from the schema).
- **⚠ The user must RE-RUN the schema SQL** (Supabase SQL editor or Admin→Diagnostics) to apply new
  triggers/columns/policies after each schema change.

## Deploy / "how do I get the changes"
1. Merge the open PR for branch `claude/wonderful-clarke-6hm5ex` into `main` (GitHub → Merge).
2. Download `index.html` from `main` and upload to the host.
3. Site is behind **Cloudflare** — if changes don't show, **Purge Everything** (cache).
4. For real internet email: deploy `email-worker.js` (full setup guide in its header), paste its URL into
   Admin → Local Insights → Mail gateway (`localStorage['kh_mail_gateway']`).

## Feature status
DONE: Mail (internal + external via worker, KHI summarise/draft/polish, folders, search, avatars),
Recent-activities switcher
(header "Recent" button = lightweight "minimise/jump between activities"), landscape mode v2,
offline login + username prefill, website shortcuts (browser New-Tab), Contributors card, Ultra progress,
admin Local Insights, Team Sudoku (share/load puzzle code), Flight Sim "How to fly", profile avatar+status,
feedback 7-day auto-prune, app-maker double-install guard,
Free Library (in-app Project Gutenberg reader — search + read full text, paginated, resume position, font
size; wired to the books tracker. Closes the one gap vs **ReKindle** — rekindle.ink, the competitor users
compare us to: it can read free Gutenberg/Libby books; we now read full text too AND keep everything else).

Split screen / "2 pages in 1" multitasking — two stacked, independently-scrolling panes, each a real view;
entry via the repurposed header "Recent" button (now the `_khOpenMultitask` panel). Delivered the community
"multitasking" request; the heavier "true N-tab background multitasking incl. KindleOS" is still pending.

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
- Editing `index.html` desyncs the editor's file-state after a `sed` write — Read again before Edit.
- Line numbers shift constantly; when wiring by line, grep the exact module/anchor first (a past batch
  mis-wired Snake/2048 new-game guards because line numbers moved between grep and edit).
- e-ink: guard text writes with `if(el.textContent!==v)el.textContent=v` to avoid flashes (clocks do this).
- e-ink perf: a per-second `setInterval` must NOT `innerHTML=''`+rebuild a list every tick — that's a full
  flash + GC churn each second. Build the structure once, then tick ONLY the changing text (guarded). World
  Clock is the canonical example: `renderClocks()` builds cards into the in-scope `grid` ref (works while the
  view is still detached during build — using `document.getElementById` there silently no-ops and caused a 1s
  empty-grid flash on entry); `tickClocks()` updates just the time/date text. Same anti-pattern still lives in
  the home countdown widget (`renderCd`) — left alone for now (only 4 rows, shared widget area).
- Per-keystroke `oninput` that re-renders a list = laggy e-ink typing — wrap in `khDebounce(fn,~200)` (RSS
  headline search, science glossary `paint`, Sheets Find now do). Leave live single-cell edits / word-counters
  un-debounced (instant feedback, cheap).
- Don't store non-serializable things in S (functions/DOM) — JSON.stringify in save() would throw and
  (previously) be misread as "storage full". `save()` now only treats real QuotaExceededError as full.
