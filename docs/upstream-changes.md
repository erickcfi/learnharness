# Upstream changes

Every upstream file that the fork changes gets one row here. Merges from upstream start by checking each file in this list.

| File | Card | Reason |
|---|---|---|
| `src/server/file-access.ts` | P1-06 | C5: when `LH_LIBRARY_DIR` is set (by the front door), File access is fixed to that one folder, whatever `settings.json` says. An empty or relative value blocks every read. |
| `app/api/graph/import/route.ts` | P1-06 | C5 requirement 3, PD3: refuse any imported file over 20 MB. Upstream's 25 MB per-upload check runs first and is unchanged. |
| `components/sidebar.tsx` | P1-10 | AGPL source link: a small "Source code" link under Settings, to `erickcfi/learnharness` at the deployed commit. |
| `next.config.ts` | P1-10 | AGPL source link: `LH_SOURCE_COMMIT` carries Railway's `RAILWAY_GIT_COMMIT_SHA` into the build. |
| `tests/notes-import-route.test.ts` | P1-06 | PD3: the "exactly 25 MiB" upload test now sends two 12.5 MiB files, because one 25 MiB file is over the 20 MB per-file limit. The test still checks the 26 MiB body headroom. |
| `tests/render-update-settings.test.tsx` | P1-10 | AGPL source link: the build-metadata test also expects the public `LH_SOURCE_COMMIT`. |
