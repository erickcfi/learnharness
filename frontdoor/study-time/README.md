# frontdoor/study-time: active study time (PD1)

Card P3-02. PRD PD1, X4, C7 req 6.

**PD1:** study time is active time: the tab is visible, and the student acted in the last 5 minutes.

The front door cannot see either from requests alone: the tutor keeps one event stream open per window and fetches again when the server tells it to, so a hidden or idle tab still makes requests. So a small script on the tutor's pages tells the front door.

## How it works

1. `script.ts`: the heartbeat script, served at `/_frontdoor/activity.js`. Every 30 seconds, if the tab is visible and the student pressed a key, clicked, touched, scrolled or moved the mouse in the last 5 minutes, it posts `{"path": "/chat/<id>"}` to `/_frontdoor/activity`. It sends only the page path, never page text.
2. `endpoint.ts`: the gateway calls it after the login check (`studentRoutes` in `gateway/handler.ts`), so a heartbeat always belongs to the tenant in the login cookie. The chat id comes from the path (`/chat/<id>`); anything else counts as study time outside any chat.
3. `credit.ts`: each heartbeat earns the time since the student's last credited heartbeat, at most 30 seconds. Two open tabs never count twice, and a script beating too fast earns only real time.
4. `recorder.ts`: writes the seconds to `study_time` with the chat id. A write that fails is kept and added to the next one (up to 6 hours per student and chat). A row the database refuses for good (a deleted tenant) is dropped.
5. `queries.ts`: reads it back. `activeSecondsBySession(db, tenantId)` is the `activeSecondsBySession` the study record builder takes (`frontdoor/records`). `studyByTenant` feeds the dashboard. `listEndedSessions` gives chats with no study time for 30 minutes. `listEndedSittings` gives ended sittings.

The script reaches every tutor page through one line in upstream `app/layout.tsx` (logged in `docs/upstream-changes.md`). A test keeps that line and the served path in step.

This folder is the one home of the 30-minute rule (master, 2026-11-08):

- **Session:** one upstream chat. **Session count:** chats with study time. **Session end:** 30 minutes with no study time in that chat. Used by the dashboard and the non-aviation flag.
- **Sitting:** one run of study across any chats, with no gap over 30 minutes. It has ended after 30 minutes with no study time at all. `listEndedSittings` returns each with its start, end, active seconds and chat ids; `since` skips sittings already handled. Used by the after-session email (W2-10).

## Known limit

A student who blocks the script never uses up trial time. The trial still ends at 7 days, and the $10 model-cost backstop (PD2) still applies.
