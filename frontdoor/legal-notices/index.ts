/**
 * The AGPL's "Appropriate Legal Notices" (LICENSE section 0, lines 91 to 98,
 * and section 5(d)). Every interactive screen shows, or links prominently to:
 *   (1) a copyright notice,
 *   (2) that there is no warranty,
 *   (3) that people may copy and share the work under this license, and
 *   (4) how to view a copy of the license (LICENSE_PATH, the full text).
 * The source code link (frontdoor/source-link) sits beside it.
 *
 * Constants only, no file access, so the tutor's client-side sidebar can
 * import it. The full license text is read on the server by license-text.ts.
 * Master decision 2026-11-09, at Erick's request ("make sure we are covered").
 */

export const LICENSE_PATH = "/legal/license";
export const LICENSE_LINK_LABEL = "License";

/** Upstream's authors (Git history) and North Aero's changes. */
export const COPYRIGHT_NOTICE = "LearnHarness © Amos Blomqvist and the LearnHarness contributors. Changes © North Aero, Inc.";

/** Permission to share, and no warranty, in one plain sentence each. */
export const LICENSE_NOTICE =
	"This is free software under the GNU Affero General Public License, version 3 (AGPL-3.0). You may copy, change and share it under that license. It comes with no warranty.";
