import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PublicShell } from "../../marketing/components/shell.tsx";
import { BRAND } from "../../marketing/copy.ts";
import "../../marketing/marketing.css";
import { BRAND_ICON_PATH } from "../../marketing/public-paths.ts";
import { SITE_ORIGIN } from "../../marketing/site.ts";
import { bodyFont, displayFont } from "./fonts.ts";

/**
 * The public pages (W2-11): landing, How it works, Help, legal. No login,
 * no Clerk, no analytics or other third-party scripts. The fonts are
 * self-hosted by next/font, so no request leaves for Google.
 * Built once at build time; the deployed commit comes from Railway.
 */
export const metadata: Metadata = {
	metadataBase: new URL(SITE_ORIGIN),
	title: { default: BRAND.name, template: `%s | ${BRAND.name}` },
	icons: { icon: BRAND_ICON_PATH },
};

export const viewport: Viewport = { themeColor: "#1a1b1d", width: "device-width", initialScale: 1 };

export default function PublicLayout({ children }: { children: ReactNode }) {
	return (
		<div className={`${displayFont.variable} ${bodyFont.variable}`}>
			<PublicShell commit={process.env.RAILWAY_GIT_COMMIT_SHA}>{children}</PublicShell>
		</div>
	);
}
