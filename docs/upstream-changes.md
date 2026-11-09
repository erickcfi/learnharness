# Upstream changes

Every upstream file that the fork changes gets one row here. Merges from upstream start by checking each file in this list.

| File | Card | Reason |
|---|---|---|
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
