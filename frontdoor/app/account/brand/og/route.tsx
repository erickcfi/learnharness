import { ImageResponse } from "next/og";
import { BRAND, LANDING } from "../../../../marketing/copy.ts";

/**
 * The share image (Open Graph) for the public pages: 1200 × 630, made at
 * build time from the page copy, so it changes when the copy does.
 * Served at /account/brand/og, which the gateway already sends here.
 */
export const dynamic = "force-static";

const CREAM = "#faf6ec";
const INK = "#1a1b1d";
const ORANGE = "#e86a28";
const PEACH = "#f6b084";

export function GET() {
	return new ImageResponse(
		(
			<div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: INK, color: CREAM, padding: "72px 80px" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 20 }}>
					<svg width="64" height="64" viewBox="0 0 32 32">
						<circle cx="16" cy="16" r="14.5" fill="none" stroke={CREAM} strokeWidth="2" />
						<path d="M16 7 L23 22 L16 18.5 L9 22 Z" fill={ORANGE} />
					</svg>
					<div style={{ display: "flex", fontSize: 34, letterSpacing: 4, textTransform: "uppercase" }}>
						<span style={{ fontWeight: 700 }}>{BRAND.school}</span>
						<span style={{ marginLeft: 14, color: PEACH }}>{BRAND.product}</span>
					</div>
				</div>
				<div style={{ display: "flex", flexDirection: "column" }}>
					<div style={{ display: "flex", fontSize: 30, color: PEACH, letterSpacing: 3, textTransform: "uppercase", marginBottom: 18 }}>{LANDING.hero.eyebrow}</div>
					<div style={{ display: "flex", flexDirection: "column", fontSize: 76, fontWeight: 700, lineHeight: 1.05 }}>
						{LANDING.hero.titleLines.map((line) => (
							<span key={line}>{line}</span>
						))}
					</div>
				</div>
				<div style={{ display: "flex", height: 10, width: 220, background: ORANGE }} />
			</div>
		),
		{ width: 1200, height: 630 },
	);
}
