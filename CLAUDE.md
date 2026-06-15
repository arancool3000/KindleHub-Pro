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
- Commit when the user asks; branch is `claude/stoic-mayer-ylygsn`. The user merges PRs (or asks me to).
  End commit messages with the session URL line.

## Architecture cheat-sheet (grep anchors)
- **State**: `let S=` (state object) persisted to `localStorage['kindlehub_v5']`, gzip-packed.
  `NOW()` = `Date.now()+S.clockOffset` — **all time display must use NOW()/clockOffset**, never raw `new Date()`.
- **Views**: builders in `const BUILDERS={ home:()=>{…}, … }`; mounted by `showView(id)` into `#mainHost`.
  Nav tabs in the `<nav>` HTML + `const NAV_TABS=[…]`. New view = add tab HTML + NAV_TABS entry + a `BUILDERS.xxx`.
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
1. Merge the open PR for branch `claude/stoic-mayer-ylygsn` into `main` (GitHub → Merge).
2. Download `index.html` from `main` and upload to the host.
3. Site is behind **Cloudflare** — if changes don't show, **Purge Everything** (cache).
4. For real internet email: deploy `email-worker.js` (full setup guide in its header), paste its URL into
   Admin → Local Insights → Mail gateway (`localStorage['kh_mail_gateway']`).

## Feature status
DONE: Mail (internal + external via worker, KHI summarise/draft/polish, folders, search, avatars),
Gallery (screenshot viewer — pick image files, thumbnail grid, full view), Recent-activities switcher
(header "Recent" button = lightweight "minimise/jump between activities"), landscape mode v2,
offline login + username prefill, website shortcuts (browser New-Tab), Contributors card, Ultra progress,
admin Local Insights, Team Sudoku (share/load puzzle code), Flight Sim "How to fly", profile avatar+status,
feedback 7-day auto-prune, app-maker double-install guard.

PENDING / bigger jobs (each its own session):
- **True minimisable multi-tab multitasking** (keep several activities "open" at once, incl. KindleOS).
  Current "Recent switcher" is the light version, not true background tabs.
- **Dedicated platformer game** — note: **DigQuest already IS a platformer** (`const DigQuest`), described
  as a 2.5D dig-and-smash story platformer. A new cleaner Mario-style platformer was requested.
- **Online real-time team games** (live shared board for 3–4 players). Team Sudoku is share-a-code only.
- Non-UTC streak date-keys (habits/notes use UTC `toISOString().slice(0,10)` — wrong rollover off-UTC).
- Screenshot viewer can't read the Kindle filesystem (web sandbox) — it's a file-picker viewer by necessity.

## Known gotchas
- Editing `index.html` desyncs the editor's file-state after a `sed` write — Read again before Edit.
- Line numbers shift constantly; when wiring by line, grep the exact module/anchor first (a past batch
  mis-wired Snake/2048 new-game guards because line numbers moved between grep and edit).
- e-ink: guard text writes with `if(el.textContent!==v)el.textContent=v` to avoid flashes (clocks do this).
- Don't store non-serializable things in S (functions/DOM) — JSON.stringify in save() would throw and
  (previously) be misread as "storage full". `save()` now only treats real QuotaExceededError as full.
