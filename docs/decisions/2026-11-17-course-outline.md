# The guided course on North Aero's own lesson outline

Approved by Erick on 2026-11-16: "Yes, rebuild it". Built by the master session's build agent on branch `course-outline`. Code in `frontdoor/course/` and `frontdoor/app/course/`; details in `frontdoor/course/README.md`.

## What changed

The `/course` page (first built 2026-11-11) used a course design that came from another product, Groundwork: three stages, subjects, and short lessons with a one-sentence outcome and key point labels. Groundwork is now a separate product. Nothing from it stays in the course: not its data, its structure, its words or its look.

The course is now North Aero's own private pilot outline: 88 lessons in 3 stages, each stage in groups. Each lesson has a number, a title, an estimate of tutor minutes, and its scope: the FAA-S-ACS-6C elements it covers, in the FAA's own words, grouped by Task. Two lessons cover the student pilot rules from 14 CFR Part 61, which the ACS does not cover; they name the 14 CFR paragraphs and their eCFR headings instead.

- **Course file** (`file.ts`): format `northaero.course`, version 2. Stages, groups, lessons (`id`, `number`, `title`, `minutes`, `acs`, `regs`). Strict as before: unknown fields are refused and every value is checked. A version 1 file (the earlier design) is refused with a plain message, so `/course` says "coming soon" until a new file is uploaded.
- **Converter** (`build-course-file.ts`, rewritten in place): `node frontdoor/course/build-course-file.ts <outline.json> <acs.json> <regs.json> <out.json>`. It joins the outline with the ACS text, checks every code and every lesson's scope, and writes the file through the upload's check. The outline, the ACS data and `regs.json` stay outside the repo.
- **First message** (`first-message.ts`): as Erick asked on 2026-11-09, "prompt like a well-prepared student. Who the student is, the lesson goal, and the ACS elements in the FAA's own wording." It is generic for a student anywhere (no aircraft, airport, hours or solo claims). One block per Task, parent lines with their sub-elements indented, then the risk elements. For the 14 CFR lessons, one block per Part. Nothing else: no hidden rules, no "not part of this lesson" list. A parent line that an earlier lesson covers is still shown when a lesson has some of its sub-elements, so they read right.
- **Address size**: the message travels in `/chat/<id>?prompt=`. The course file check refuses any lesson whose address would pass 6 KB. The longest real message is about 3 KB of text and about 4 KB in the address.
- **Page**: heading, "88 lessons in 3 stages.", then each stage ("Stage 1: ...") with its groups as subheadings and numbered lessons, each with "About 25 to 40 minutes" and the same actions as before (Start lesson; Started with Continue and Start again; a plain sentence at the top while a lesson cannot start). The look is the `/account` pages'.
- **Words in the code**: "lesson" throughout (`findLesson`, `LessonStartMarks`, `recordLessonStart`, `listLessonStarts`). The Start form posts `lesson=<id>`; an unknown id comes back as `?error=no-lesson`. The new chat is titled "Lesson <n>: <title>".

## What stayed

- `endpoint.ts`, `marks.ts`, `live-chats.ts`, `blocks.ts`, the gateway routes and the same-origin check work as before.
- **The table keeps its name.** `course_leg_starts` and its `leg_id` column were already applied. No migration was added or changed: `leg_id` now stores the lesson id (`l05`). Started marks stored under the earlier design's ids simply match no lesson.
- The library upload (area "Course", stored as `course/private-pilot.course.json`) and the coming-soon fallback.

## Lesson ids

The converter makes `l` plus the lesson number (`l01` to `l88`). If lessons are ever renumbered, those ids move with the numbers, and so would Started marks. An outline lesson may carry its own `id` to keep it.

## Not kept in use

The tests now use an invented kite course (`tests/fixtures/frontdoor-course/outline/`). The earlier design's fixtures (`tests/fixtures/frontdoor-course/groundwork/`) were removed on 2026-11-19 with Erick's yes.
