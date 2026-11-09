import { Inter, Oswald } from "next/font/google";

/** North Aero's type (flynorthaero.com): Oswald for headings, Inter for text.
 *  next/font downloads them at build time and serves them from this site. */
export const displayFont = Oswald({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--na-font-display", display: "swap" });
export const bodyFont = Inter({ subsets: ["latin"], variable: "--na-font-body", display: "swap" });
