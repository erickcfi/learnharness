# Upstream changes

Every upstream file that the fork changes gets one row here. Merges from upstream start by checking each file in this list.

| File | Card | Reason |
|---|---|---|
| `.github/workflows/ci.yml` | CI | The Standalone jobs download Electron up front with up to 5 tries and growing waits, before the native renderer tests. GitHub's release downloads timed out (HTTP 504) many times on 2026-11-08 and 2026-11-09, failing the job before any test ran (Owner's OK, 2026-11-09). |
| `package.json` | P1-02 | Adds `"workspaces": ["frontdoor"]`, so one `npm ci` installs the front door's packages too (Owner, 2026-11-08). |
| `package-lock.json` | P1-02 | Lock entries for the `frontdoor` workspace and its new packages (`@clerk/nextjs`, `@clerk/backend`). |
| `tsconfig.json` | P1-02 | Excludes `frontdoor/.next` (the front door's build output) from the root type check. |
| `eslint.config.mjs` | P1-02 | Ignores `frontdoor/.next/**` and the generated `frontdoor/next-env.d.ts`, like the root ones. |
| `package.json`, `package-lock.json` | P1-03 | Add `postgres` (the database driver for the tutor's Supabase project) and the dev dependency `@electric-sql/pglite` (in-process Postgres for the database tests). |
| `src/agent/models.ts` | P2-01 | Metering (X2). With `LH_ANTHROPIC_BASE_URL` set, the Anthropic provider sends every request to that address, the metering proxy. Unset, requests are untouched. Adds `viaMeteringProxy` and one call to it in `piModels()`. |
| `src/server/search.ts` | P2-02 | Search counter (X2, C3 requirement 7). With `LH_TAVILY_BASE_URL` set, Tavily searches go to that address, the metering proxy, which counts them per tenant. Unset, upstream's endpoint. Adds `tavilySearchUrl()`, used by `tavilyProvider`. |
| `src/server/file-access.ts` | P1-06 | C5: when `LH_LIBRARY_DIR` is set (by the front door), File access is fixed to that one folder, whatever `settings.json` says. An empty or relative value blocks every read. |
| `app/api/graph/import/route.ts` | P1-06 | C5 requirement 3, PD3: refuse any imported file over 20 MB. Upstream's 25 MB per-upload check runs first and is unchanged. |
| `components/sidebar.tsx` | P1-10 | AGPL source link: a small "Source code" link under Settings, to `erickcfi/learnharness` at the deployed commit. |
| `next.config.ts` | P1-10 | AGPL source link: `LH_SOURCE_COMMIT` carries Railway's `RAILWAY_GIT_COMMIT_SHA` into the build. |
| `tests/notes-import-route.test.ts` | P1-06 | PD3: the "exactly 25 MiB" upload test now sends two 12.5 MiB files, because one 25 MiB file is over the 20 MB per-file limit. The test still checks the 26 MiB body headroom. |
| `tests/render-update-settings.test.tsx` | P1-10 | AGPL source link: the build-metadata test also expects the public `LH_SOURCE_COMMIT`. |
| `package-lock.json` | W1-6 | `tsx` is now a front door dependency, because it runs `frontdoor/server.ts` in production (master decision, 2026-11-08). Its lock entries, and esbuild's, lose the dev-only mark. |
| `package-lock.json` | P4-01 | Lock entries for `stripe` 23.1.0, the official Stripe package, a front door dependency (W2-8). |
| `components/sidebar.tsx` | AGPL | A "License" menu item beside "Source code", to the front door's `/legal/license` page (copyright, no warranty, permission to share, full license text). The AGPL's "Appropriate Legal Notices" (LICENSE section 0 and 5(d)); a prominent menu item meets them (master, 2026-11-09). |
| `components/sidebar.tsx` | P4-03 | An "Account" link to `/account/plans` (the plans and billing screen) beside "Source code" (master, 2026-11-08). One line. The master repoints it at an `/account` home page later. |
| `app/layout.tsx` | P3-02 | Study time (PD1, master decision 2026-11-08): one line, `<script async src="/_frontdoor/activity.js" />`. The front door serves that heartbeat script (`frontdoor/study-time`); it tells the front door when the tab is visible and the student acted in the last 5 minutes. Without the front door the request finds nothing and the page is unchanged. |
| `proxy.ts` | P1-05 (W2-6) | Tenant wall A (master decision, 2026-11-08). The `matcher` is removed, so Proxy runs on every path. With `LH_HOSTED=1` (set by the front door), the desktop secret is checked on every path, pages and `/_next` files included, and a missing or short secret refuses everything. Unset, only `/api` is checked, as upstream does. |
| `tests/desktop-api.test.ts` | P1-05 (W2-6) | Follows the `proxy.ts` change: Proxy has no matcher now, so the test no longer asserts that `/chat/new` is outside it. It asserts instead that, outside hosted mode, a page passes without the secret. Marked as a fork change. |
| `src/agent/tools/web.ts` | P1-05 (W2-6) | Tenant wall B: `web_fetch` uses `safeFetch` (`frontdoor/isolation/safe-fetch.ts`). With `LH_HOSTED=1` it refuses loopback, private, link-local and metadata addresses, after the name lookup and on every redirect. Unset, plain `fetch()`. One import and one call changed. |
| `src/agent/tools/pdf-read.ts` | P1-05 (W2-6) | Tenant wall B for `web_fetch_pdf`, the same way as `web_fetch`. One import and one call changed. |
| `app/layout.tsx` | P2-04 | Hosted mode: wraps the app in `HostedProvider` (`frontdoor/isolation/hosted.tsx`), with `LH_HOSTED === "1"` read on the server at each request. |
| `components/model-picker.tsx` | P2-04 | Hosted mode hides the model and thinking pickers and turns off their shortcuts (⌘K model menu, Shift+Tab thinking level). The model still reaches the stats bar. |
| `components/settings/settings-dialog.tsx` | P2-04 | Hosted mode drops the Providers and General sections and opens on Agent. |
| `components/settings/agent-section.tsx` | P2-04 | Hosted mode hides Models, File access, Search engine and System prompts, and skips their reads of `/api/keys` and `/api/settings/prompts`. |
| `components/settings/subscription-client.ts` | P2-04 | Hosted mode gives no subscription bridge, so no status calls to `/api/subscriptions` (which the front door blocks). |
| `components/dictation.tsx` | P2-04 | Hosted mode (N13): no mic button, no dictation shortcut, no token pre-fetch from `/api/stt/token`. |
| `components/settings/keyboard-section.tsx` | P2-04 | Hosted mode lists no shortcut for the hidden controls (dictation, model menu, thinking cycle). |
| `components/stats-bar.tsx` | W2-6 | Hosted mode hides the session's dollar costs (summary, total, unpriced count, per turn). One switch: `HIDE_COSTS_WHEN_HOSTED` (master, 2026-11-08). |
| `components/graph-view.tsx` | W2-6 | Hosted mode hides the graph cost pill (`GraphCostControl`), on the graph view and the home page. Same switch. |
| `components/activity-dock.tsx` | W2-6 | Hosted mode hides background-agent costs (total, per job, job detail). Same switch. |
| `package.json`, `package-lock.json` | Security | Security updates (master's task, 2026-11-09). The lockfile takes `npm audit fix`'s patched versions, all inside the ranges `package.json` already allows: `dompurify`, `undici`, `zod`, `puppeteer-core` (and its `chromium-bidi`), `fast-uri`, `source-map-js`, and the dev tools `concurrently`, `brace-expansion` and `@typescript-eslint/*`. `package.json` gains one `overrides` entry, `"ansi-to-react": { "linkify-it": "^5.0.2" }`: the newest `ansi-to-react` (6.2.6) still asks for `linkify-it` 3, which has a high-severity slowdown bug fixed in 5.0.2. Nothing in the app imports `ansi-to-react` today. Drop the override when upstream updates or removes `ansi-to-react`. |
| `src/core/session-markdown.ts` | Export | Bug fix (master, 2026-11-10). Question blocks printed "The learner chose: [object Object]": the answer record stores each choice as `{ label, value, index }` (`question-core.ts`), and the renderer joined the objects. It now prints the labels (plain strings still work). It also reads the learner's reasoning from `thinking`, with the old `note` key as a fallback; the 2026-10-03 rename had left the export reading only `note`. "his thinking" and "in his own words" now read "their". The same renderer feeds the extractor, which saw the same "[object Object]". |
| `tests/session-markdown.test.ts` | Export | Follows the fix above: two wording checks now say "their", and two new tests cover a real answer record and the `thinking` key. |
| `components/sidebar.tsx` | Course | A "Course" link to `/course` (the guided course page, `frontdoor/course`) under Settings, above Account (master, 2026-11-11). One line. Starting a lesson uses upstream's own paths unchanged: `POST /api/chats`, then `/chat/<id>?prompt=`. |
