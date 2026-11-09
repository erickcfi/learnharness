/**
 * Search and share tags for the public pages (W2-11): title, description,
 * canonical link and Open Graph image. Next.js replaces a layout's
 * openGraph block with a page's, so every page builds the whole set here.
 */
import type { Metadata } from "next";
import { BRAND } from "./copy.ts";
import { OG_IMAGE_PATH } from "./public-paths.ts";
import { SITE_ORIGIN } from "./site.ts";

export const OG_IMAGE = { url: OG_IMAGE_PATH, width: 1200, height: 630, alt: BRAND.name };

export function pageMetadata({ title, description, path, absoluteTitle = false }: { title: string; description: string; path: string; absoluteTitle?: boolean }): Metadata {
	const fullTitle = absoluteTitle ? title : `${title} | ${BRAND.name}`;
	return {
		metadataBase: new URL(SITE_ORIGIN),
		title: absoluteTitle ? { absolute: title } : title,
		description,
		alternates: { canonical: path },
		openGraph: { type: "website", siteName: BRAND.name, title: fullTitle, description, url: path, images: [OG_IMAGE] },
		twitter: { card: "summary_large_image", title: fullTitle, description, images: [OG_IMAGE.url] },
	};
}
