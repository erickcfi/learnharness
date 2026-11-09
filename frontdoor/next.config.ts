import type { NextConfig } from "next";

/**
 * The front door's own pages live under /account (Owner, 2026-11-08).
 * Upstream LearnHarness also serves its files under /_next/, so the front
 * door's files move to /account/_next/ (assetPrefix), and the custom server
 * sends every /account request here. Pages sit in app/account/, so Clerk's
 * components see ordinary paths.
 *
 * No `output: "standalone"`: a custom server cannot use it (Next.js
 * custom-server guide). The front door runs from the full install.
 */
const nextConfig: NextConfig = {
	assetPrefix: "/account",
	poweredByHeader: false,
};

export default nextConfig;
