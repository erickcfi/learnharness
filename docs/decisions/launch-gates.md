# Launch gates: evidence (P7-02)

| Item | Value |
|---|---|
| Card | P7-02, gate review. PRD section 9. |
| Status | Started 2026-11-11. No gate has passed yet. |
| Who signs off | Erick, for each gate. Claude records the evidence. |
| Launch steps | `docs/launch-runbook.md`. Its step B1 needs all four gates passed. |

Each gate below has the rule from the PRD, the evidence so far, and what is still needed. Add new evidence with its date. Do not remove old evidence.

## Summary (2026-11-11)

| Gate | Rule in short | State | Next step |
|---|---|---|---|
| G1 | Cost per study hour supports $69 | Open. Two data points, T7 not run. | T7 (Erick) |
| G2 | Terms, privacy policy, AI notice published | Not started on the site. Drafts exist. | Erick reads and decides the drafts |
| G3 | Model check case 1 passes on launch settings | Not started | After T7 sets the launch settings |
| G4 | Every test green | Green on `main` at `4ec1b5d` | Rerun on the commit that ships |

## G1. Cost

**Rule (PRD section 9).** The measured average cost per study hour supports $69.

- At 20 study hours a month, the 2x rule (D7) needs $1.73 an hour or less.
- T7 measures full study hours.

**Evidence so far.**

| Date | What | Model and thinking | Cost | Per hour | Where it ran |
|---|---|---|---|---|---|
| 2026-11-06 | Probe and plan only, about 10 minutes | Opus 5.5, high | $0.61 | $3.66 (that phase only) | PRD G1 |
| 2026-11-07 | First student session, 45 minutes | Opus 5.5, high | $2.75 | About $3.67 ($2.75 / 0.75 h) | Outside staging, so the meter did not record it and P0-07 got no memory reading |

Facts that bear on the gate:

- Both data points are single sessions. Neither is an average over students.
- Both are above the $1.73 an hour the rule names.
- T7 has not run. T7 is two one-hour runs: Run A with high thinking ("Teach me to decode a TAF") and Run B with medium thinking ("Teach me to read a winds aloft forecast"), each with cost, length and cache hit rate, plus the Cheap slot model and the Strong slot Cache setting (PRD section 10, `docs/kanban.md`).
- Until T7, the Strong slot is Opus 5.5 with high thinking (C3 req 3), and the Cheap and Vision slots are Sonnet 5.5 (master, 2026-11-08).
- Open gaps: K1 (cost per study hour), K2 (average study hours per student), K5 (searches per session; each Tavily search is $0.008 and is not in the numbers above), K6 (Cheap slot and Cache setting).
- Fair-use settings today: alert at $60 and autopause at $89 of model cost in 30 days (D15). The trial ends at 2 hours of study or $10 of model cost (D10, PD2). These are to be reset after T7 (C3 req 5).
- Prices are Erick's call (D7, D34). This document states facts only.

**Still needed.**

1. Erick runs T7, Run A and Run B. On staging is best: the meter then records every call per tenant, and Claude can read the service's memory at the same time (P0-07).
2. Tester data, once testers study, for K2.
3. Erick decides the launch price and the Strong slot thinking level, and records it in the decision log. The gate passes when he marks it passed here.

## G2. Legal documents

**Rule (PRD section 9).** The terms, the privacy policy and the AI notice (T5) are published. Claude drafts them and the Owner approves them, with no lawyer review (D32). They cover:

- the terms, including the fair-use limit and one person per account
- the privacy policy, including what North Aero can see (D19)
- California auto-renewal rules, including the notice before an annual renewal
- the AI notice
- the 18+ rule

**Evidence so far.**

- Claude drafted all three on 2026-11-08: terms, privacy policy and AI notice. They are in Erick's project folder (`legal-drafts\`), not in this public repo, until he approves them (master, 2026-11-08).
- They are not approved. Each has items marked for Erick.
- The site shows "Coming soon." at `/legal/terms`, `/legal/privacy` and `/legal/ai-notice` (W2-11 placeholders). `/legal/license` already shows the full AGPL text.
- What the code already does for California auto-renewal: Checkout requires the terms box; the tutor sends a sign-up confirmation and a notice 30 days before an annual renewal from `billing@ground.flynorthaero.com`; cancellation is online through Stripe's portal (`frontdoor/billing/README.md`).
- Facts the privacy policy must state, from earlier decisions:
  - North Aero sees usage numbers and topics for every student, and session text only for testers with written OK and students who opt in (D19).
  - After the day-91 delete, only a one-way hash of the email and Stripe's card fingerprint are kept, to block repeat trials (master, 2026-11-08).
  - Deleted data leaves the backups within 30 days (`docs/decisions/2026-11-08-backups.md`).

**Still needed (Erick).**

1. Read the three drafts and decide each marked item: refunds, how the fair-use limit is stated, where disputes are heard, North Aero's mailing address, the effective date, and a check of Anthropic's current terms on the data line.
2. Approve the final text. Claude then puts it on the site in place of "Coming soon." through a pull request.
3. Approve the student-facing wording that refers to the terms: `frontdoor/billing/copy.ts` (Checkout's terms box and billing emails) and `frontdoor/marketing/copy.ts`.
4. After the terms page is live, set the terms URL in Stripe live mode's Public details (`docs/launch-runbook.md`, step A4).

Students under 18 stay out at launch (D28). T8 (a path for minors) is not part of this gate.

## G3. Model check case 1

**Rule (PRD section 9).** Model check case 1 passes on the launch settings.

- Prompt: "Teach me to decode a METAR."
- To pass, the tutor must ask the right staging questions, write correctly formatted METARs, and build a complete, useful plan.
- The Owner judges the result. Sonnet 5.5 failed this case on 2026-11-06.

**Evidence so far.**

- 2026-11-06: Sonnet 5.5 failed this case (PRD).
- Not yet run on the launch settings. Those settings are not final: the Strong slot is Opus 5.5 with high thinking until T7, and the Cheap and Vision slots are Sonnet 5.5 until Erick changes them after T7.

**Still needed (Erick).**

1. Finish T7 and set the launch models and thinking level (C3 req 3).
2. On staging, with those settings, open a new chat and send "Teach me to decode a METAR."
3. Judge it against the three points above, and record here: the date, the models and thinking level, pass or fail, and a short reason. The chat's export (`/api/chats/<id>/markdown`; the export fix in PR #24 shows the chosen answers) can be kept with Erick's notes.
4. If the launch models or thinking level change later, run the case again (D6).

## G4. Tests

**Rule (PRD section 9).** Every test is green, including the isolation and file lockdown tests.

**Evidence so far.**

- `main` at `4ec1b5d` (PR #24, merged 2026-11-10): CI passed. 4,292 tests pass, 0 fail, 6 skipped. Lint is clean apart from one old warning, upstream's `tests/source-name-ui.test.tsx`, there since the P0-05 baseline. All 6 GitHub checks passed on PR #24, the macOS build included.
- The isolation tests (W2-6, PRD C1) and the file lockdown and library tests (W1-3, PRD C5 and C4) are part of `npm test`, so they are in that count.
- 2026-11-11, this docs branch (`launch-docs`, from `4ec1b5d`, documents only): typecheck, lint and `npm test` rerun locally. Results in the pull request that adds this file.

**Still needed.**

1. Rerun the gate (`npm run typecheck`, `npm run lint`, `npm test`) on the exact commit that ships, and see every GitHub check pass on it.
2. GitHub's macOS machines were short several times (PRs #21 and #22 merged without the Mac check, each on Erick's yes). Decide before launch day what to do if that happens on the launch commit.

## Related checks outside the four gates

These are not in the PRD's gate list, but the Wave 2 done criterion and the PRD acceptance tests ask for them. None is recorded as done in the decision log as of 2026-11-11.

- **Backup restore** of one student's folder on staging (X3, `docs/decisions/2026-11-08-backups.md`). Railway backups were turned on for staging on 2026-11-10.
- **Stripe sandbox checks on staging** (`frontdoor/billing/README.md`, "What only staging with real test keys can check"): the one-trial-per-card refusal, Buy now, the day-7 conversion, a portal cancel, `invoice.upcoming` for an annual plan, the tester code's $0 invoices and its 4th redemption refused. The free trial itself and the cards-only Checkout were seen on staging on 2026-11-10.
- **Email (C6):** a session report and a weekly report arriving, turning a report off, and DKIM PASS on a real message. Email has been on for staging since 2026-11-10.
- **Before testers or launch:** the log filter gaps the master listed for P7 (Node's own crash printout, and error messages that are pure unquoted student text).
