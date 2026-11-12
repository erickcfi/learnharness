# frontdoor/course: the guided course page

Master's decision, 2026-11-11. A signed-in student opens `/course` and sees the private pilot ground school: three stages (before you solo, before cross-country, checkride prep), then subjects, then Legs (short lessons). Each Leg shows its title, its one-sentence outcome and how many key points it has. "Start lesson" opens a new tutor chat whose first message sets up that Leg.

## The tutor keeps teaching its own way

PRD D2: probe, plan, teach, check. The tutor's prompts and tools are unchanged. The only course input is the first message (`first-message.ts`), kept minimal (Erick, 2026-11-09):

```
I am a student pilot working toward the private pilot certificate. I would like to work on this lesson.

Lesson: <Leg title>
Outcome: <Leg outcome>
ACS: <code>; <code>
This lesson should cover:
- <key point label>
- <key point label>
```

The ACS line is left out when a Leg has no codes. Groundwork's data has no FAA wording for the codes, so only the codes go in. Never key point statements, source passages or quizzes: those are under review and must not reach students yet.

## The course data stays private

The repo is public and the curriculum is not. Real course data is never committed. Tests use invented data (`tests/fixtures/frontdoor-course`, `tests/helpers/frontdoor-course.ts`).

1. On a machine with Groundwork (read only): `git -C ~/review/groundwork pull --ff-only`, then from the repo root:

   ```bash
   node frontdoor/course/build-course-file.ts ~/review/groundwork <somewhere outside the repo>/private-pilot.course.json
   ```

   It prints the size and the counts. It reads Groundwork's `scripts/courses/private-pilot.subjects.json`, `src/content/course/index.json`, `scripts/courses/legs/*.json` (the labels) and `src/content/course/subjects/*.json` (only each Point's `id` and `acs`). It writes ids, stages, subjects, Legs, and per Leg the title, outcome, ACS codes and key point labels. Nothing else.
2. The Owner uploads that file on `/admin/library`, area "Course". The upload runs the same check (`file.ts`, which refuses any field it does not name) and stores it as `<volume>/library/course/private-pilot.course.json`.
3. The front door reads it from there (`source.ts`), again only when its size or time changes. No valid file: `/course` says the course is coming soon.

## How a lesson starts (`endpoint.ts`)

`POST /course/start` with the Leg's id, from the page's own form (same-origin check). The gateway sends `/course` and `/course/start` here after the login check, the pause screen and the trial gate, like a tutor page. Then, using upstream's own paths unchanged:

1. `POST /api/chats` on the student's own tutor server (with its secret header), titled with the Leg's title, as upstream's New session does.
2. A row in `course_leg_starts` (tenant, Leg id, chat id, time).
3. A 303 to `/chat/<id>?prompt=<first message>`. Upstream's chat page sends `?prompt=` as the first message, once, only while the chat has no conversation. The longest real message is under 1 KB in the URL.

## Started marks (`marks.ts`)

`/course` shows "Started" on a Leg the student started, with "Continue" (the newest chat) and "Start again". "Done" is out of scope for now. Table `course_leg_starts`, migration `frontdoor/supabase/migrations/20261111000100_course_leg_starts.sql`, which needs the Owner's yes before it is applied. Until then the page works with no marks and logs one line.

## When a lesson cannot start (`blocks.ts`)

Paused (C3 req 6), or with billing on: trial used up, plan ended, or no plan. `/course` then shows a plain sentence instead of "Start lesson" (words in `copy.ts`), and `/course/start` opens no chat.

Cards fallback (Erick, 2026-11-11): pre-written question cards are a fallback only, for when the model cannot be reached or the student has hit a budget cap. They are not built. The two places they would go are marked in `endpoint.ts` and `app/course/course-screen.tsx`.

## Files

| File | What |
|---|---|
| `file.ts` | The course file format and its strict check. Plain Node. |
| `build-course-file.ts` | The converter from Groundwork. Plain Node. |
| `first-message.ts` | The lesson's first message. |
| `source.ts` | Reads the course file from the library volume. |
| `marks.ts` | Started marks, safe without the table. |
| `blocks.ts` | Paused or budget cap: no new lesson. |
| `endpoint.ts` | `/course` and `/course/start` for the gateway. |
| `view.ts`, `registry.ts`, `index.ts` | The page's data, the runtime the Next.js page reads, and the wiring. |
| `copy.ts` | Every word a student sees. |
| `../app/course/` | The page (`page.tsx`, `course-screen.tsx`, `layout.tsx`). |
