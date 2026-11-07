# North Aero Ground Tutor

A paid, multi-user fork of LearnHarness for ground.flynorthaero.com.

@AGENTS.md

## Read before any work

- `docs/PRD.md`: what we build. Read sections 1 to 5 every session.
- `docs/plan.md`: how a build session runs, step by step.
- `docs/kanban.md`: your card, its PRD IDs, and its done criterion.
- `docs/upstream-changes.md`: every upstream file the fork has changed.

## Rules

- Teaching behavior stays upstream's (D2). Fork code serves hosting only.
- New code goes in `frontdoor/`. Log every upstream file edit in `docs/upstream-changes.md` (N9).
- When the PRD or your card leaves a choice open, ask the Owner (N10).
- Tests first: the card's acceptance tests go red, then green, and every upstream test stays green.
