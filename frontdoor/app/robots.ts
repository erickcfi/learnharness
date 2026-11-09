import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "../marketing/site.ts";

/** robots.txt (W2-11): search engines may read the public pages and the
 *  share image, nothing behind the login. */
export default function robots(): MetadataRoute.Robots {
	return {
		rules: {
			userAgent: "*",
			allow: ["/", "/account/brand/"],
			disallow: ["/api/", "/account/", "/chat/", "/settings"],
		},
		sitemap: `${SITE_ORIGIN}/sitemap.xml`,
	};
}
