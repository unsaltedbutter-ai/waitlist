"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/hooks/use-auth";

const navLinks = [
  { href: "/operator", label: "Hub" },
  { href: "/operator/jobs", label: "Jobs" },
  { href: "/operator/business", label: "Business" },
  { href: "/operator/waitlist", label: "Waitlist" },
  { href: "/operator/dead-letter", label: "Dead Letter" },
];

export default function OperatorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading: authLoading } = useAuth();
  const pathname = usePathname();

  if (authLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-muted">Loading...</p>
      </main>
    );
  }

  if (!user) return null;

  return (
    <main className="min-h-screen">
      <div className="max-w-5xl mx-auto px-4 py-10 space-y-6">
        <Link
          href="/operator"
          className="text-3xl font-bold tracking-tight text-foreground hover:text-accent transition-colors"
        >
          Operator
        </Link>

        <nav className="flex gap-1 border-b border-border pb-2 overflow-x-auto">
          {navLinks.map((link) => {
            const isActive =
              link.href === "/operator"
                ? pathname === "/operator"
                : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`text-xs px-3 py-1.5 rounded-t transition-colors ${
                  isActive
                    ? "bg-accent text-background font-semibold"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        {children}
      </div>
    </main>
  );
}
