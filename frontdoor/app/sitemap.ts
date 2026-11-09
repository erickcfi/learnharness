import type { MetadataRoute } from "next";
import { PUBLIC_PAGES } from "../marketing/public-paths.ts";
import { SITE_ORIGIN } from "../marketing/site.ts";

/** sitemap.xml (W2-11): the public pages only. */
export default function sitemap(): MetadataRoute.Sitemap {
	return PUBLIC_PAGES.map((path) => ({ url: `${SITE_ORIGIN}${path}` }));
}
