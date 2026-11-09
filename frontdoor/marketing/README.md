# Public pages (W2-11)

The landing page, the "How it works" tour, the Help page, the legal placeholders and the footer. Public, no login, no Clerk, no analytics or other third-party scripts.

## Where to change things

| To change | Edit |
|---|---|
| Any text on the public pages, and the text on the sample tutor screens | `copy.ts` |
| Prices, the trial length and the trial study hours | `../plans/index.ts` (the only place prices live) |
| The site address, the contact email | `site.ts` |
| Colors, type, layout, animations | `marketing.css` |

After a change, run `npm test` (the tests check that no page holds a price of its own, that the text has no em dashes, and that the trial button leads to sign-up), then deploy.

## Layout

| Path | What |
|---|---|
| `public-paths.ts` | The public paths. The gateway (`../gateway/handler.ts`) reads it. |
| `components/shell.tsx` | Header, footer (with the AGPL source link), page frame. |
| `components/pages.tsx` | The page contents. Prices arrive as props from `../plans`. |
| `components/screens.tsx` | The stylized tutor screens, built from the real tutor's labels. |
| `components/tour.tsx` | The landing page's tour (client component). |
| `components/play-on-view.tsx` | Plays a screen's animation when it scrolls into view (client component). |
| `motion.ts` | Reduced motion: still frames unless the browser says motion is fine. |
| `metadata.ts` | Title, description, canonical link and share image for each page. |
| `../app/(public)/` | The Next.js routes: `/`, `/how-it-works`, `/help`, `/legal/*`. |
| `../app/robots.ts`, `../app/sitemap.ts` | Search files, public pages only. |
| `../app/account/brand/og/route.tsx` | The share image, made at build time. |
| `../public/account/brand/icon.svg` | The browser tab icon. |

## Routing

- `/` shows the landing page only to a visitor with no front door login. A signed-in student goes to their tutor. A visitor still signed in to Clerk (Clerk's `__client_uat` cookie) goes to sign-in, which forwards them to their tutor.
- `/how-it-works`, `/help`, `/legal/*`, `/robots.txt` and `/sitemap.xml` always come from the front door (GET and HEAD only). Upstream LearnHarness has no routes there.
- Everything else is unchanged: `/api` answers 401 without a login, other pages redirect to sign-in.

Tests: `tests/frontdoor-landing-*.test.ts(x)`.
