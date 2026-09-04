import type { Metadata } from "next";
import "./globals.css";

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
