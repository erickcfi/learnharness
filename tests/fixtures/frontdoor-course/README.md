# Invented course data for the course tests

Everything here is made up. The real outline never goes in this repo.

- `outline/`: a tiny course about kites in the shape of the private lesson
  outline (`outline.json`), the ACS data (`acs.json`, invented `ZZ` codes)
  and the regulation headings (`regs.json`, an invented 14 CFR Part 199), so
  `frontdoor/course/build-course-file.ts` can be tested without the real
  data. `tests/helpers/frontdoor-course.ts` holds the course file it makes.
- `groundwork/`: the fixture of the course design used before the lesson
  outline (docs/decisions/2026-11-17-course-outline.md). No test uses it
  any more; it stays until its removal is approved.
