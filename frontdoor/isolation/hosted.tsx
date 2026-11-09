"use client";
/**
 * Hosted mode for upstream's UI (W2-6, PRD C3 req 3, N2, N3, N13; card
 * P2-04). The front door starts every tenant server with LH_HOSTED=1. The
 * root layout (app/layout.tsx, a server component, rendered per request)
 * reads it and passes it down here, so client components can hide what a
 * student can't use: the model and thinking pickers and Shift+Tab, Providers
 * and keys, File access, System prompts, the desktop-only General section,
 * and the dictation mic. The front door's route table refuses those routes
 * anyway (gateway/route-policy.ts); hiding them means nothing errors.
 *
 * With LH_HOSTED unset (upstream's desktop and dev runs), useHosted() is
 * false and every control shows as upstream builds it.
 */
import { createContext, useContext, type ReactNode } from "react";

const HostedContext = createContext(false);

export function HostedProvider({ hosted, children }: { hosted: boolean; children: ReactNode }) {
	return <HostedContext.Provider value={hosted}>{children}</HostedContext.Provider>;
}

/** True when this server runs for the North Aero front door (LH_HOSTED=1). */
export function useHosted(): boolean {
	return useContext(HostedContext);
}
