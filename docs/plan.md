# Build plan

This plan turns `docs/PRD.md` into ordered work. The cards live in `docs/kanban.md`. Cards are grouped into work packages. Each package is one build session: a fresh Claude Code agent that finishes the package on its own branch. Up to five packages run at the same time (D33).

## How a build session runs

1. **Load context.** Read `CLAUDE.md`, `AGENTS.md`, PRD sections 1 to 5 and the sections the package names, this plan, and the package's cards. Done when you can name the package's PRD IDs and its done criteria.
2. **Work in the package's worktree.** The coordinating session creates a git worktree at `~/lh-wt/<package>` on a branch named after the package, for example `w1-front-door`, installs packages, and moves the package to In progress.
3. **Ask first.** List every design or implementation choice that the PRD and the cards do not settle. Send all of them, in one batch with a recommendation for each, to the coordinating session before you write code (N10). Since 2026-11-08 the coordinating session decides build questions for the Owner and logs each decision. It still brings money, outside accounts, price, legal text and big student-facing changes to the Owner. Done when no open choice remains and the plan is approved.
4. **Red.** Write the package's acceptance tests. Run them and see each one fail for the expected reason.
5. **Green.** Write the code until the package's tests pass.
6. **Gate.** Run `npm run typecheck`, `npm test`, and `npm run lint`. Every upstream test stays green. Done when all three commands pass.
7. **Log upstream edits.** If you changed any upstream file, add a row to `docs/upstream-changes.md` that names the file and the reason.
8. **Hand off.** Commit on the package's branch and report: the gate output, the commits, new dependencies, upstream files edited, and anything blocked. The coordinating session reruns the gate at that commit, pushes it, and opens the pull request with the gate output in it. It merges the pull request once every GitHub check passes (Owner's standing OK, 2026-11-08), then moves the package to Done.

## Parallel agents

- Each package has its own worktree and branch, cut from `origin/main`. An agent stays in its own worktree and its own files.
- The `frontdoor/` app skeleton (`package.json`, `tsconfig.json`, Next.js files) belongs to the front door package. Other packages put framework-free code in `frontdoor/<area>/`, and their tests in `tests/frontdoor-<area>-*.test.ts`, so the root `npm test` runs them.
- Agents do not edit `docs/kanban.md` or `docs/plan.md`. The coordinating session keeps both.
- Agents add npm dependencies only when needed, and list them in their report. Branches merge one after another. The coordinating session merges `main` into the next branch, reruns the gate, and regenerates `package-lock.json` when two branches change it.
- Agents push nothing. The coordinating session pushes finished branches, opens pull requests, and merges them once every check passes (Owner's standing OK, 2026-11-08). Accounts and settings at outside services (Railway, Supabase, Clerk, Stripe, AWS, the Claude Console) still need the Owner's yes each time.

## Branches, upstream, and tags

- `main` is the branch that deploys. Every change reaches `main` through a pull request with green CI.
- The remote `upstream` points at `amosblomqvist/learnharness`. Merge upstream into a branch, never straight into `main`. Then run the contract tests (C7) and the full gate.
- Push branches only: `git push origin <branch>`. Upstream's `v*` tags then stay out of the fork, so upstream's desktop release workflow (`.github/workflows/release.yml`, which runs on `v*` tags) never starts here.

## Where fork code lives

- **New code** goes in `frontdoor/` (X5). This covers the front door, the metering proxy, the dashboard, and the login, plan, pause, and record screens.
- **Route blocks** for students (section 4, fact 6) live in the front door, so no upstream route changes for them.
- **Planned upstream edits:**
  - `src/agent/models.ts` and `src/server/search.ts`, for metering (X2).
  - Possibly small UI edits, to hide model and thinking controls (C3).
  - Each one gets a row in `docs/upstream-changes.md`.

## Waves

| Wave | Packages | Starts | Done when |
|---|---|---|---|
| 0 | P0-01 to P0-07 | 2026-11-07 | The fork is public. CI is green. Staging runs behind a password. Live-turn memory is recorded. |
| 1 | W1-1 front door, W1-2 database, W1-3 lockdown, W1-4 metering, W1-5 reporting | 2026-11-08 | Each package's tests are green and merged. X5 is approved. |
| 2 | W2-6 isolation and limits, W2-7 pause and data safety, W2-8 Stripe, W2-9 dashboard, W2-10 email reports | When W1-1 merges. Packages that write to the database also wait for W1-2. | The C1, C2 (Stripe test mode), C3, C4, C5, C6, and C7 tests are green, and a backup restore works. |
| Testers | P7-01 | When W1-1, W1-2, W1-3, W1-4, and W2-6 are merged | 3 testers use staging, with written consents on file. |
| 3 | P7-02 to P7-04 | When wave 2 is merged | Every launch gate passes, and DNS points to Railway. |

## Order and dependencies

- **Dependencies set the order, not phase numbers.** The front door (W1-1) is the only package that the others wait for.
- **Security comes first for real data.** Real student data reaches staging only after the security set is merged: W1-1 front door, W1-2 database, W1-3 lockdown, W1-4 metering, and W2-6 isolation and limits (which holds the C3 route blocks and the model lock). Until then, only the Owner uses staging.
- **The Owner tickets run alongside the build.** T1 to T4 fill the library before launch, through the upload page in W2-9. T5 feeds gate G2. T7 feeds gate G1 and the C3 model settings. P0-07 does not block wave 1.
