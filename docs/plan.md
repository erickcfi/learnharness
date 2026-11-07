# Build plan

This plan turns `docs/PRD.md` into ordered work. The cards live in `docs/kanban.md`. Each card is one build session: a fresh Claude Code session that finishes one card.

## How a build session runs

1. **Load context.** Read `CLAUDE.md`, PRD sections 1 to 5, this plan, and your card. Done when you can name the card's PRD IDs and its done criterion.
2. **Claim the card.** Move it to In progress in `docs/kanban.md`, and create a branch named after the card ID in lower case, for example `p1-02-front-door`.
3. **Ask first.** List every design or implementation choice that the PRD and the card do not settle. Ask the Owner about each one before you write code (N10). Done when no open choice remains.
4. **Red.** Write the card's acceptance tests. Run them and see each one fail for the expected reason.
5. **Green.** Write the code until the card's tests pass.
6. **Gate.** Run `npm run typecheck`, `npm test`, and `npm run lint`. Every upstream test stays green. Done when all three commands pass.
7. **Log upstream edits.** If you changed any upstream file, add a row to `docs/upstream-changes.md` that names the file and the reason.
8. **Hand off.** Push the branch, open a pull request, and paste the gate output in it. Move the card to Review. The Owner merges.

## Branches, upstream, and tags

- `main` is the branch that deploys. Every change reaches `main` through a pull request with green CI.
- The remote `upstream` points at `amosblomqvist/learnharness`. Merge upstream into a branch, never straight into `main`. Then run the contract tests (C7) and the full gate.
- Push branches only: `git push origin <branch>`. Upstream's `v*` tags then stay out of the fork, so upstream's desktop release workflow (`.github/workflows/release.yml`, which runs on `v*` tags) never starts here.

## Where fork code lives

- **New code** goes in `frontdoor/` (X5). This covers the front door, the metering proxy, the dashboard, and the login, plan, pause, and record screens.
- **Route blocks** for students (section 4, fact 6) live in the front door, so no upstream route changes for them.
- **Planned upstream edits:**
  - `src/agent/models.ts` and `src/server/search.ts`, for metering (X2).
  - Possibly `proxy.ts`, as the staging fallback (X6).
  - Possibly small UI edits, to hide model and thinking controls (C3).
  - Each one gets a row in `docs/upstream-changes.md`.

## Phases

| Phase | Cards | PRD | Done when |
|---|---|---|---|
| 0 | P0-01 to P0-07 | Section 8, phase 0. X6. | The fork is public. CI is green. Staging runs behind a password. Live-turn memory is recorded. |
| 1 | P1-01 to P1-10 | X5, C1, C5, X3, cross-cutting requirements | The C1 and C5 tests are green, and a backup restore works. |
| 2 | P2-01 to P2-06 | C3, X2 | The C3 tests are green. |
| 3 | P3-01 to P3-06 | C7 | The C7 tests are green. |
| 4 | P4-01 to P4-07 | C2, X4 | The C2 tests are green in Stripe test mode. |
| 5 | P5-01 to P5-02 | C4 | The C4 tests are green. |
| 6 | P6-01 to P6-05 | C6 | The C6 tests are green. |
| 7 | P7-01 to P7-04 | Section 9 | Every launch gate passes, and DNS points to Railway. |

## Order and dependencies

- Each phase starts only after the phase before it is merged.
- **Phase 1 must finish before staging holds real student data.** Until Phase 2 is merged, only the Owner and testers use staging. C3 blocks the server-wide settings routes.
- **The Owner tickets run alongside the build.** T1 to T4 feed Phase 5. T5 feeds gate G2. T7 feeds gate G1 and the C3 model settings.
