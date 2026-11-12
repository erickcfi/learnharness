import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { LegalNoticeLine } from "../../legal-notices/notice.tsx";
import { AdminNav } from "./_components/nav.tsx";
import "./admin.css";

/**
 * The Owner's dashboard (W2-9, C7). Only the Owner reaches these pages: the
 * gateway checks the login and role before Next.js sees the request
 * (frontdoor/admin/handler.ts), and each page checks again (_lib/guard.ts).
 * Never indexed: noindex here and in every answer's X-Robots-Tag, and in
 * neither the sitemap nor robots.txt.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Ground Tutor admin",
	robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1a1b1d" };

export default function AdminLayout({ children }: { children: ReactNode }) {
	return (
		<div className="dash">
			<AdminNav />
			<main className="dash-main">{children}</main>
			{/* AGPL legal notices (frontdoor/legal-notices). */}
			<footer style={{ padding: "12px 16px" }}>
				<LegalNoticeLine commit={process.env.RAILWAY_GIT_COMMIT_SHA} />
			</footer>
		</div>
	);
}
