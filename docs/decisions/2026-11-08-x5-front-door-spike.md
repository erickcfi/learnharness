# Spike result: X5 (front door technology)

Date: 2026-11-08. Fork `main` at `fadc7ec` (upstream `713377f`). Next.js 16.4.3, Node 26.13.0. Run in WSL Ubuntu on the Owner's machine, not on Railway. Card P1-01.

**Status: DECIDED. The Owner approved method A on 2026-11-08.**

## Question

Can a Next.js 16 front door pass a server-sent event stream from a tenant's LearnHarness server to the student without holding it back? A server-sent event stream (SSE) is one long HTTP response that the server keeps writing to, a little at a time. The tutor's live answers and LearnHarness's notification channel both use it. If the front door buffers (collects the pieces and sends them late, or all at once), the tutor looks frozen.

## Method

1. Build upstream as in production: `npm run build && node scripts/build-server.mjs`.
2. Build a throwaway front door: a Next.js 16 app with a custom Node server. A custom server is our own small Node program that receives every request first, and hands to Next.js only the requests that are meant for the front door's own pages. It holds three ways to pass a request through to a tenant:
   - **A. Custom server.** Our Node program copies the request to the tenant and copies the answer back, piece by piece (`node:http` piping).
   - **B. Route handler.** A Next.js API route fetches the tenant and returns the answer's body as a stream.
   - **C. Proxy rewrite.** Next.js `proxy.ts` rewrites the request to the tenant's address.
   - **Baseline.** The client talks to the tenant directly.
3. Run two tenants:
   - **A real LearnHarness server,** started as the X1 spike did, with its own `LH_DATA_DIR`. The stream is `GET /api/events`. Each `POST /api/chats` (create a session) makes the server send one frame. A frame is one message on the stream.
   - **A stand-in tenant** that sends 25 frames, one every 200 ms. Each frame carries the time it was sent. It runs twice: with upstream's stream headers, and without `Cache-Control: no-transform`. That header tells servers in between not to change (for example, compress) the response.
4. For every frame, measure the delay from send to arrival. The client asks for compressed responses, as browsers do.

Scripts: `2026-11-08-x5-spike/` in this folder. Run `bash docs/decisions/2026-11-08-x5-spike/run.sh .` from the repo after the build. It builds the throwaway front door in `.spike-x5/`, runs every test, and removes it.

## Results

Two full runs gave the same picture. Numbers are from the second run.

**Stand-in tenant, upstream's headers** (25 frames, 200 ms apart, so the last one is due at about 5,000 ms):

| Path | Median delay | Worst delay | Last frame arrived |
|---|---|---|---|
| Baseline (direct) | 1 ms | 8 ms | 5,034 ms |
| A. Custom server | 2 ms | 9 ms | 5,042 ms |
| B. Route handler | 2 ms | 15 ms | 5,059 ms |
| C. Proxy rewrite | 1 ms | 11 ms | 5,047 ms |

**Stand-in tenant, without `no-transform`:**

| Path | Median delay | Worst delay | Notes |
|---|---|---|---|
| Baseline (direct) | 1 ms | 7 ms | |
| A. Custom server | 2 ms | 6 ms | |
| B. Route handler | 2 ms | 7 ms | |
| C. Proxy rewrite | 2,412 ms | 4,815 ms | **Buffered.** Next.js compressed the stream (gzip), and all 25 frames arrived together at 5,044 ms. |

**Real LearnHarness server, `GET /api/events`,** 10 session creates each:

| Path | Frames arrived | Median delay | Worst delay |
|---|---|---|---|
| Baseline (direct) | 10 of 10 | 10 ms | 18 ms |
| A. Custom server | 10 of 10 | 7 ms | 9 ms |
| B. Route handler | 10 of 10 | 9 ms | 10 ms |
| C. Proxy rewrite | 10 of 10 | 8 ms | 9 ms |

**Other checks through the custom server:** the LearnHarness home page returned HTTP 200 (27 KB, 12 ms). `POST /api/chats` returned HTTP 200. The front door process used about 99 MB of memory (RSS) after the run.

## Findings

1. **The custom server never buffered.** Its delays match the direct path in every test, with or without `no-transform`. Next.js is not in its path, so Next.js's compression cannot hold a stream back.
2. **The route handler did not buffer** in these tests.
3. **The proxy rewrite buffers any stream that lacks `no-transform`.** Upstream sets that header on all three of its stream responses today (`src/server/events-stream.ts`, `src/server/pi/ui-stream.ts`, `src/server/turn-runs.ts`), so it works now. A future upstream stream without the header would freeze silently, and only for students.
4. Passing pages and POST requests through the custom server works.

## Recommendation

Approve X5 as the PRD recommends: **a Next.js 16 app in `frontdoor/`, with a custom Node server that passes requests and streams through to each tenant's server (method A).**

Why method A:

- It is the only method that is immune to buffering from compression.
- It is a long-lived program, so it can start and watch over the tenant servers (X1 jobs 2 and 3). Next.js route code runs per request and is not built for that.
- It passes every method and body through as a stream, including 20 MB imports (PD3), without Next.js's own body-size limit for `proxy.ts`.
- It keeps one language and framework with upstream, and Clerk and Stripe both support Next.js.

The cost: the Next.js docs say a custom server cannot use `output: "standalone"`. So the front door runs from the full install (`node_modules`), not from a trimmed bundle. On Railway this costs nothing extra, because the build has the full install anyway.

## What the spike found for the build

1. **The login check in the pass-through.** Clerk's `clerkMiddleware` runs inside Next.js. Requests the custom server passes through never reach Next.js. So the custom server checks the login itself.
2. **Clerk's login token lasts 60 seconds.** Clerk's script on the page renews it every 50 seconds (Clerk docs, "How Clerk works", read 2026-11-08). LearnHarness's pages do not load that script, and Clerk renews a token only on page loads, never on the app's background requests. Without a fix, the student app's requests would start failing about a minute after login. The Owner chooses the fix.
3. **Both apps serve their files under `/_next/`.** The front door's pages need their own path prefix, so the custom server can tell the two apps apart. The Owner chooses the prefix. Built with the pages in `app/account/` and Next.js `assetPrefix: "/account"`, so the front door's files load from `/account/_next/`. Next.js `basePath` was not used: Clerk's docs say nothing about it, and Clerk's components would see changed paths.

## Limits

- Not run on Railway. Railway's own edge in front of the service is not tested here. P0-06 tests streams through Railway.
- No live model turn, because there is no API key here. `GET /api/events` uses the same stream format and the same headers as the turn stream.
- One tenant server at a time.

## Decision

Approved by the Owner, 2026-11-08: a Next.js 16 app in `frontdoor/`, with a custom Node server that passes requests and streams through to each tenant's server (method A).

## The Owner's answers for the build (2026-11-08)

| Choice | Answer |
|---|---|
| Keeping students logged in (finding 2) | The front door sets its own signed login cookie after the Clerk login, and re-checks the Clerk session every 5 minutes. No change to LearnHarness. |
| The 18+ checkbox (C1 req 5) | On the front door's signup page, before Clerk's form. Clerk's form appears only after it is ticked. The tick is saved with its date, and no tenant folder is created without it. |
| Packages | `frontdoor/` is an npm workspace with its own package list. The root `package.json` lists it. |
| Path prefix (finding 3) | `/account`. When the dashboard is built, `/admin` forwards to `/account/admin`. |
| Cheap and Vision slots until T7 | `claude-sonnet-5-5` in both, default thinking. Strong stays `claude-opus-5-5` with high thinking. |
