# frontdoor/library: the source library and the Owner's upload page

Card P5-01. PRD C4 req 1 to 3, PD6.

The library is `<volume>/library/`, with `faa/`, `ntsb/`, `poh/<aircraft>/` and `north-aero/` (C4 req 1). Every tenant's tutor reads it through upstream's file tools, locked to it by lockdown (`frontdoor/settings-template`). No student can change it.

The Owner adds, replaces and removes files on `/admin/library`. The routes are in `frontdoor/admin/handler.ts`; this folder does the file work.

## Rules (`rules.ts`)

- Types the tutor reads: `.pdf` (the pdf job), `.md`, `.txt`, `.csv` (the read tool), `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` (the read tool). The first bytes must match the type (a PDF starts with `%PDF-`, text has no NUL byte, images have their usual signature).
- Up to 100 MB a file. FAA handbooks run 20 to 80 MB. PD3's 20 MB limit is for student imports, not the library.
- File names keep letters, digits, space, dot, dash and underscore. Any folder part of the name is dropped.
- POH files go in a folder per aircraft, named with lowercase letters, digits and dashes (for example `c172s`).

## How a file is saved (`store.ts`)

The upload streams to `<volume>/.library-incoming/` (next to the library, owner-only), is checked, then renamed into place. A tutor never sees half a file, and a failed upload leaves nothing behind. A file of the same name is replaced only when the Owner confirms. Nothing is written through a link, and links are skipped in the listing. Removing needs a confirm step and works only on a file inside the library.
