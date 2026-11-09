# Upstream changes

Every upstream file that the fork changes gets one row here. Merges from upstream start by checking each file in this list.

| File | Card | Reason |
|---|---|---|
| `package.json` | P1-02 | Adds `"workspaces": ["frontdoor"]`, so one `npm ci` installs the front door's packages too (Owner, 2026-11-08). |
| `package-lock.json` | P1-02 | Lock entries for the `frontdoor` workspace and its new packages (`@clerk/nextjs`, `@clerk/backend`). |
| `tsconfig.json` | P1-02 | Excludes `frontdoor/.next` (the front door's build output) from the root type check. |
| `eslint.config.mjs` | P1-02 | Ignores `frontdoor/.next/**` and the generated `frontdoor/next-env.d.ts`, like the root ones. |
