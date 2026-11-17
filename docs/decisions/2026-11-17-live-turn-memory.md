# Memory during a live teaching turn (P0-07, PRD K3)

Recorded 2026-11-17 by the master session, from Railway's metrics for the `learnharness` service in the staging environment. Read only; nothing was changed.

## The session

On 2026-11-13 the first tester signed up on staging and studied from about 17:54 to 19:56 UTC: 43 model calls, $3.72 of model cost, all on North Aero's key. No other student was studying. A deploy ran from 19:30 to 19:35 UTC, in the middle of the session.

## Readings

`MEMORY_USAGE_GB`, 1-minute samples, whole service (front door plus every tenant server).

| When (UTC, 2026-11-13) | Memory | What it is |
|---|---|---|
| 17:40 to 17:48 | about 0.47 GB | Before the tester signed up |
| 17:49 | 0.71 GB | The tester's tenant server starts |
| 17:53 onward | about 0.66 GB | Tester's server running |
| 19:16 | **0.707 GB** | Peak during live teaching, before the deploy |
| 19:34 | 0.972 GB | One sample during the deploy: about 0.685 + 0.287, old and new containers overlapping |
| 19:35 to 19:39 | 0.26 to 0.46 GB | New container: the front door alone at first, then the tester's server again |
| 20:14 | 0.671 GB | Peak after the deploy |
| 23:34 | 0.844 GB | One sample during a later redeploy (same overlap pattern) |

## What it means

- **Peak during a live turn: 0.71 GB for the whole service,** with one student studying. The two single high samples (0.97 and 0.84 GB) are deploy overlaps, not teaching.
- **One tenant server adds about 0.19 to 0.24 GB,** live turns included. That is close to the 207 MB estimate in PD4. For costs, plan on about 240 MB per tenant server.
- **The front door alone uses about 0.26 to 0.29 GB** (right after a restart, before any student's server starts).
- The service limit is 24 GB, so memory is far from a limit at tester scale.

## Limits of this reading

- One student and one session. Several students teaching at once, long chats, and large library lookups may use more.
- Railway reports the service total only, with no breakdown per process or container. The per-tenant number is the step when the tester's server started.
- The deploy in the middle of the session restarted the tester's server once.

PRD K3 is updated with these numbers. Railway charges $10 per GB per month, so about 240 MB per tenant server is about $2.40 per student per month.
