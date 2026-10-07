import type { Metadata } from "next";
import "./globals.css";

// The middleware's nonce-based script CSP (src/middleware.ts) reaches Next's
// bootstrap scripts only on dynamically rendered documents: prerendered HTML
// is produced at build time with no request nonce, so 'strict-dynamic' blocks
// every script a static page serves (measured live — issue 1046's headless
// pass found /terms, /account-data and every 404 serving blocked scripts with
// hydration dead before this flag). Next's CSP guide requires it: "When you
// use nonces in your CSP, all pages must be dynamically rendered." The root
// layout is the one segment whose config covers every route, the not-found
// route included, so the declaration lives here.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Overflow — cooperative credit",
  description: "A cooperative ledger for open-source work.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
