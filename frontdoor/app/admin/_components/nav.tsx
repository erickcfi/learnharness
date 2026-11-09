"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
	{ href: "/admin", label: "Students" },
	{ href: "/admin/library", label: "Library" },
	{ href: "/admin/settings", label: "Settings" },
];

export function AdminNav() {
	const pathname = usePathname();
	return (
		<header className="ad-top">
			<span className="ad-brand">Ground Tutor admin</span>
			{LINKS.map((l) => {
				const current = l.href === "/admin" ? pathname === "/admin" || pathname.startsWith("/admin/students") : pathname.startsWith(l.href);
				return (
					<Link key={l.href} href={l.href} aria-current={current ? "page" : undefined}>
						{l.label}
					</Link>
				);
			})}
		</header>
	);
}
