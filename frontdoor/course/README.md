# frontdoor/course: the guided course page

A signed-in student opens `/course` and sees North Aero's private pilot ground school: 88 lessons in 3 stages, each stage in groups. Each lesson shows its number, title and an estimate such as "About 25 to 40 minutes". "Start lesson" opens a new tutor chat whose first message sets up that lesson. Decision record: `docs/decisions/2026-11-17-course-outline.md` (Erick, 2026-11-16: "Yes, rebuild it").

## The tutor keeps teaching its own way

PRD D2: probe, plan, teach, check. The tutor's prompts and tools are unchanged. The only course input is the first message (`first-message.ts`), written like a well-prepared student (Erick, 2026-11-09): who the student is, the lesson, and its ACS elements in the FAA's own words.

```
I am a student pilot working toward the FAA private pilot certificate. I would like to work on this lesson.

Lesson <number>: <lesson title>
Stage <number>: <stage title>

From the Private Pilot ACS (FAA-S-ACS-6C), Task <I.B>, <Task name>. I should understand:
- K1 <FAA text>, including:
  - K1a <FAA text>
And be able to identify, assess, and mitigate risk associated with:
- R1 <FAA text>
```

- One block per Task when a lesson spans several Tasks.
- A sub-element is indented under its parent line. When a lesson has sub-elements whose parent line an earlier lesson covers, the parent line is still shown (marked `context` in the file) so the sub-elements read right.
- A Task with risk elements only starts "I should be able to identify, assess, and mitigate risk associated with:".
- Lessons on rules the ACS does not cover (the student pilot rules) get "From 14 CFR Part 61 (the ACS does not cover these rules):", then each section with its heading and the paragraphs with theirs.

Generic for a student anywhere: nothing about their aircraft, airport, hours or solo. Nothing hidden either: no extra rules, no "not part of this lesson" list.

The message travels in the chat address (`/chat/<id>?prompt=`). The course file check refuses a lesson whose address would pass 6 KB with the longest chat id. With the real outline the longest is about 3 KB of text and 4 KB in the address.

## The course data stays private

The repo is public and the outline is not. Real course data is never committed. Tests use invented data (a tiny course about kites: `tests/fixtures/frontdoor-course/outline/`, `tests/helpers/frontdoor-course.ts`).

1. The outline lives outside the repo: `acs_course_outline.json` (the 88 lessons: number, stage, group, title, ACS codes, minutes, milestone, and `regs` for the lessons on rules the ACS does not cover) and `private_acs.json` (the FAA-S-ACS-6C elements, FAA wording). Next to the output, a small private `regs.json` holds the eCFR headings, verbatim, of the 14 CFR sections and paragraphs those lessons name: `{ "source": "...", "headings": { "14 CFR 61.xx": "<section heading>", "14 CFR 61.xx(b)": "<paragraph heading>", ... } }`.
2. From the repo root:

   ```bash
   node frontdoor/course/build-course-file.ts <outline.json> <private_acs.json> <regs.json> <somewhere outside the repo>/private-pilot-88.course.json
   ```

   It joins each lesson's codes with the FAA text, grouped by Task in ACS order, adds context parent lines, expands `14 CFR 61.87(b), (c)` into paragraphs with their headings, and checks that every code is in the ACS data, every lesson has scope and the lessons are in order. It prints the size, the counts and the longest first message, and writes the file only when it passes the same check as the upload. The milestone is not carried over. An optional `id` on an outline lesson keeps its id if lessons are ever renumbered; otherwise the id is `l` and the number (`l05`).
3. The Owner uploads that file on `/admin/library`, area "Course". The upload runs the same check (`file.ts`) and stores it as `<volume>/library/course/private-pilot.course.json`, whatever it was called.
4. The front door reads it from there (`source.ts`), again only when its size or time changes. No valid file: `/course` says the course is coming soon.

## The course file (`file.ts`)

Format `northaero.course`, version 2. Strict: a field it does not name is refused, and every value is checked.

```
{ format, version: 2, id, title,
  stages: [ { title,                        // "Stage 1" is its place in the list
    groups: [ { title,
      lessons: [ { id: "l05", number: 5, title, minutes: [25, 40],
        acs:  [ { task: "PA.I.B", name: "<Task name>",
                  elements: [ { code: "PA.I.B.K1a", type: "K", text: "<FAA text>", sub: true, context?: true } ] } ],
        regs: [ { cite: "14 CFR 61.xx", heading, paragraphs: [ { cite: "14 CFR 61.xx(b)", heading } ] } ] } ] } ] } ] }
```

- Lessons are numbered 1, 2, 3... in course order; ids are unique.
- `minutes` is two whole numbers, the shortest first.
- Each lesson needs ACS elements or regulations (or both).
- An element's code belongs to its Task, its type matches its code (K or R), `sub` is true exactly for a sub-element (K1a), and a sub-element comes after its parent line. `context` is only `true`, only on a parent line, and only with some of its sub-elements after it. Counts leave context lines out of the ACS elements.
- A version 1 file (the course design used before the outline) is refused: "this is the old course file (version 1, from before the lesson outline). Make a new one with build-course-file.ts".

## How a lesson starts (`endpoint.ts`)

`POST /course/start` with `lesson=<id>`, from the page's own form (same-origin check). The gateway sends `/course` and `/course/start` here after the login check, the pause screen and the trial gate, like a tutor page. Then, using upstream's own paths unchanged:

1. `POST /api/chats` on the student's own tutor server (with its secret header), titled "Lesson <number>: <title>", as upstream's New session does.
2. A row in `course_leg_starts` (tenant, lesson id, chat id, time).
3. A 303 to `/chat/<id>?prompt=<first message>`. Upstream's chat page sends `?prompt=` as the first message, once, only while the chat has no conversation.

## Started marks (`marks.ts`)

`/course` shows "Started" on a lesson the student started, with "Continue" (the newest chat) and "Start again". "Done" is out of scope for now.

The table is `course_leg_starts` (migration `frontdoor/supabase/migrations/20261111000100_course_leg_starts.sql`, already applied). It keeps its first name and its `leg_id` column: no migration was added for the outline. `leg_id` now holds the lesson id (`l05`). Starts stored under the earlier design's ids simply match no lesson. Without the table the page still works with no marks and logs one line.

A student can delete a chat in the tutor. So the page reads the student's chat list once (`live-chats.ts`: `GET /api/chats` on their own server, with its secret, as the dashboard does). "Continue" opens the newest chat for the lesson that still exists. If none is left, the lesson keeps "Started" and offers "Start lesson" again. If the tutor server does not answer within 5 seconds, "Continue" opens the newest chat.

## When a lesson cannot start (`blocks.ts`)

Paused (C3 req 6), or with billing on: trial used up, plan ended, or no plan. `/course` then shows one plain sentence at the top instead of the "Start lesson" buttons (words in `copy.ts`); "Continue" still works. `/course/start` opens no chat.

Cards fallback (Erick, 2026-11-11): pre-written question cards are a fallback only, for when the model cannot be reached or the student has hit a budget cap. They are not built. The two places they would go are marked in `endpoint.ts` and `app/course/course-screen.tsx`.

## The page

`app/course/course-screen.tsx` uses the `/account` pages' look: the same width, type, buttons and notice box. The heading, "88 lessons in 3 stages.", one line on how a lesson works, then each stage ("Stage 1: <stage title>") with its groups as subheadings and the numbered lessons. Students see numbers, titles and minutes, never ids or the lesson's scope.

## Files

| File | What |
|---|---|
| `file.ts` | The course file format and its strict check. Plain Node. |
| `build-course-file.ts` | The converter from the private outline. Plain Node. |
| `first-message.ts` | The lesson's first message, and the 6 KB address limit. |
| `source.ts` | Reads the course file from the library volume. |
| `marks.ts` | Started marks, safe without the table. |
| `live-chats.ts` | Which chats still exist, so "Continue" skips deleted ones. |
| `blocks.ts` | Paused or budget cap: no new lesson. |
| `endpoint.ts` | `/course` and `/course/start` for the gateway. |
| `view.ts`, `registry.ts`, `index.ts` | The page's data, the runtime the Next.js page reads, and the wiring. |
| `copy.ts` | Every word a student sees. |
| `../app/course/` | The page (`page.tsx`, `course-screen.tsx`, `layout.tsx`). |
