# Route blocks, model lock and tenant walls (W2-6)

Cards P1-05, P2-03, P2-04. PRD C1, C3 requirements 1 to 3, N2, N3, N13, section 4 fact 6. Decided by the master session on 2026-11-08 (both wall layers), with the open points sent to the master in one batch.

## How a request is checked

1. The front door checks the login (unchanged).
2. It checks the route table: `frontdoor/gateway/route-policy.ts` (the table) and `frontdoor/gateway/route-guard.ts` (applies it).
   - An API route or method not in the table gets **403** (default deny). A test walks `app/api` and fails when a route or method has no row, so a new upstream route is noticed and stays refused until someone classifies it.
   - A blocked API call gets **403** with JSON `{"error": "<plain message>"}`.
   - A page (any path outside `/api`) passes on GET and HEAD. Any other method on a page is refused (403), because upstream has no Server Actions. No upstream page needs blocking today. A blocked page would redirect home (`BLOCKED_PAGES`).
   - A path with an empty segment (`//`) or an encoded slash or backslash (`%2F`, `%5C`) gets 400, so the front door and Next.js always read the same path.
3. It passes the request to the student's own server, adding that server's secret header (wall A, below).

## The table

Access classes: **allowed** (passes), **read-only** (GET and HEAD pass, nothing else), **blocked** (403), **checked** (passes only after a body check).

| Route | Methods | Access | Why |
|---|---|---|---|
| `/api/activity` | GET | allowed | The student's own running work. |
| `/api/activity/abort` | POST | allowed | Stops the student's own running work. |
| `/api/chat` | POST | allowed | A teaching turn. The meter counts it and refuses it while the student is paused. |
| `/api/chats` | GET, POST | allowed | The session list, and a new session. A new session takes the Strong model from settings.json, which is the Owner's template. |
| `/api/chats/[id]` | GET, PUT, DELETE | allowed | Read, rename or delete one of the student's own sessions. |
| `/api/chats/[id]/artifact-ui` | POST | allowed | Answers inside a demo or quiz card. |
| `/api/chats/[id]/dismiss` | POST | allowed | Dismisses a card. |
| `/api/chats/[id]/images/[snapshotId]` | GET | allowed | Images in the session. |
| `/api/chats/[id]/markdown` | GET | allowed | Exports a session as markdown (records use it too). |
| `/api/chats/[id]/settings` | PUT | **blocked** | Per-session model and thinking level (N2, C3 req 3). |
| `/api/chats/[id]/steer` | POST | allowed | Steers a running turn. |
| `/api/chats/[id]/stream` | GET | allowed | The session's live stream. |
| `/api/claude-code` | GET | **blocked** | Claude Code provider (section 4 fact 6). |
| `/api/custom-provider` | GET, POST, PATCH, DELETE | **blocked** | Custom provider (fact 6). |
| `/api/events` | GET | allowed | The app's notification stream. |
| `/api/graph` | GET | allowed | The student's knowledge graph. |
| `/api/graph/costs` | GET | read-only | What graph work cost, as upstream shows it. |
| `/api/graph/coverage/extract` | POST | allowed | Graph extraction for a session. Metered. |
| `/api/graph/import` | POST | allowed | The student's own notes and PDFs (N4), 20 MB per file. Metered. |
| `/api/graph/nodes/[id]` | DELETE | allowed | Deletes a fact from the student's graph. |
| `/api/graph/positions` | PUT | allowed | Saves the graph layout. |
| `/api/graph/render-settings` | GET, PUT | allowed | The graph view's display settings. |
| `/api/graph/sources` | GET, DELETE, POST | allowed | The student's imported notes. |
| `/api/graph/status` | GET | allowed | Extraction status. |
| `/api/jobs` | GET | allowed | The student's background jobs. |
| `/api/keys` | GET | **blocked** | Keys, even masked (C3 req 1, N3, fact 6). |
| `/api/keys/[id]` | PUT, DELETE | **blocked** | Setting or deleting keys (fact 6). |
| `/api/models` | GET | read-only | The model catalog the composer reads. It names providers and whether a key exists, never a key. |
| `/api/search` | GET | read-only | Whether web search works. Never a key. |
| `/api/settings` | GET | read-only | The settings record. It holds no secret. |
| `/api/settings/general` | PUT | allowed | Automatic update checks (desktop only, hidden in hosted mode). |
| `/api/settings/appearance` | PUT | allowed | Colors and fonts. |
| `/api/settings/graph` | PUT | allowed | Graph settings. |
| `/api/settings/compaction` | PUT | allowed | When long sessions are summarized. Open point Q3 in the master batch. |
| `/api/settings/agent` | PUT | **checked** | Tool switches, quiz style, graph tools, prompt switches and search engine. Refused unless `models` (per-role overrides) is absent or empty and `fileAccess` equals the Owner's library-only section. |
| `/api/settings/chat` | PUT | **blocked** | The chat default model and thinking level (N2). |
| `/api/settings/models` | PUT | **blocked** | The model slots (N2, fact 6). |
| `/api/settings/claudeCode` | PUT | **blocked** | The Claude Code opt-in (provider). |
| `/api/settings/dictation` | PUT | **blocked** | Dictation is off (N13). |
| `/api/settings/[section]` | PUT | **blocked** | Any other section name. |
| `/api/settings/prompts` | GET | **blocked** | The tutor's instructions (fact 6). |
| `/api/settings/prompts/[...segment]` | PUT, DELETE | **blocked** | Changing the tutor's instructions (fact 6, D2). |
| `/api/stt/token` | GET | **blocked** | Dictation token (N13, fact 6). |
| `/api/subscriptions` | GET, POST | **blocked** | Subscription providers (fact 6). |
| `/api/subscriptions/browser` | GET, POST | **blocked** | Subscription sign-in (fact 6). |

Pages: `/`, `/chat/new`, `/chat/[id]` and `/settings` (which redirects to `/chat/new`) all stay readable. The blocked controls inside them are hidden (below).

The agent-section body is read by the front door (64 KB at most), decoded as the tenant will decode it (UTF-8 without a byte-order mark, then `JSON.parse`), checked, and sent on byte for byte. A body the front door cannot parse is refused (400), never forwarded.

## Model lock and settings sync (P2-04)

- The Owner's template (`frontdoor/tenants/settings-template.ts`) owns `models`, `agent.fileAccess`, `agent.models` (none) and the `chat`, `customProvider` and `claudeCode` sections (none).
- `provisionTenant()` writes it at every login and, since W2-6, before **every tenant start** (`prepare` in the supervisor). So if a tenant's `settings.json` drifts, the template wins at the next start.
- A student cannot write any of those through the API (the table above).
- New sessions take the Strong model from the template (upstream fact 10). Existing sessions keep the model they were born with. Restamping them when the Owner changes the template is left to whoever makes the template editable (open point Q5).

## Hidden controls (hosted mode)

One switch: `LH_HOSTED=1`. The supervisor sets it for every tenant server, in the fixed part of the environment that `extraEnv` cannot change. The root layout reads it on the server and passes it to client components (`frontdoor/isolation/hosted.tsx`). With the switch on:

- The composer's model and thinking pickers are hidden, and so are their shortcuts (⌘K for the model menu, Shift+Tab for the thinking level).
- Settings drops the Providers section (keys, providers, subscriptions, Claude Code, the dictation language) and the desktop-only General section. It opens on Agent.
- In Settings → Agent, the Models group, File access, Search engine and System prompts are hidden. Their reads of `/api/keys` and `/api/settings/prompts` are skipped.
- The dictation mic is hidden. Its shortcut and its token pre-fetch are off.
- Settings → Keyboard lists no shortcut for the hidden controls (dictation, model menu, thinking cycle).
- The subscription status calls to `/api/subscriptions` are not made.

With `LH_HOSTED` unset, upstream's desktop and dev behavior is unchanged. Known gap: Next's built-in 404 page is prerendered at build time, so its settings dialog would still show the hidden sections. The route table refuses those requests anyway.

## Tenant-to-tenant walls

**Wall A, a secret per tenant server.** The supervisor gives each tenant server a new random secret at every start (`LH_DESKTOP_API_SECRET`, 48 random bytes, 64 characters). The front door adds it as `x-learnharness-desktop` to every request it passes through, and drops any copy a browser sends. With `LH_HOSTED=1`, upstream's `proxy.ts` checks it on **every path**: pages, `/_next` files and `/api`. A missing or short secret refuses everything (fork edit). So a request that reaches a tenant's port without that tenant's secret is refused, whether it comes from another tenant's tutor, a stray process, or a wrong port.

Any front door code that calls a tenant server directly (records, the dashboard's topics and session text, email reports) must send the secret. Use `TenantSupervisor.endpoint(tenantId)`, which gives `{ port, url, headers }`, or `tenantFetch(tenantId, path, init)`. `startFrontDoor()` returns `tenantEndpoint(tenantId)`. `fetchRecordSource(url, fetchImpl)` already takes a fetch that can add the header.

Side effects of a set secret, checked:
- Upstream's web subscriptions (`webSubscriptionsEnabled()`) turn **off** when the secret is set. The desktop IPC paths also need `LH_DESKTOP_SERVER=1` and an IPC channel, and tenants have neither. So students have no subscription path.
- The custom-provider route swaps its same-origin check for the secret check. The front door adds the secret to every request, so that route must stay blocked. It is blocked in the table, and a test covers it.

**Wall B, no private addresses for the tutor's web tools.** `web_fetch` and `web_fetch_pdf` (both upstream tools, fork edit) use `frontdoor/isolation/safe-fetch.ts` in hosted mode. It refuses loopback, private, carrier-grade NAT, link-local (cloud metadata), unique-local (Railway's private network), multicast, reserved and documentation addresses, IPv4 and IPv6, including IPv4 written inside IPv6. It looks the name up once, checks every address, and connects only to those checked addresses, so a second lookup cannot answer differently. It follows redirects by hand and checks every hop.

Not covered by wall B: the demo builder renders demos in a server-side browser (Electron or Chrome), and JavaScript in those pages could reach 127.0.0.1. On Railway there is no such browser, so demo jobs fail before rendering. If one is ever installed, wall A still protects the tenant servers, and the meter still needs a pass key.

## Each tenant's temp folder

Each tenant server's `TMPDIR` is `<tenant folder>/.tmp`. Upstream's research jobs write downloaded PDFs to the temp folder, so background jobs now write only inside the tenant's own folder (C1 req 4). Day-91 deletion removes the folder with the rest of the tenant's data.

## Tests

- `tests/frontdoor-isolation-route-table.test.ts`: the table covers every route and method, and the decisions.
- `tests/frontdoor-isolation-gateway.test.ts`: the gateway with the table. 401 without a login on every route, 403 on every blocked route, the secret header, the agent-section check.
- `tests/frontdoor-isolation-safe-fetch.test.ts`: address ranges, the guarded fetch, the real `web_fetch` and `web_fetch_pdf` tools.
- `tests/frontdoor-isolation-tenants.test.ts`: the C1 suite. Two real tenant processes running upstream's own route code, the real supervisor, meter and front door.
- `tests/frontdoor-isolation-hosted-ui.test.tsx`: the hidden controls.
