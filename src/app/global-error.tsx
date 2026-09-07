"use client";

import Link from "next/link";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="landing-page">
          <section className="landing-hero" aria-labelledby="global-error-title">
            <p className="eyebrow">Overflow</p>
            <h1 id="global-error-title">Something went wrong.</h1>
            <p className="landing-lede">Please try again, or return to the home page.</p>
            {error.digest && (
              <p className="proof-fingerprint">Error reference: <code>{error.digest}</code></p>
            )}
            <p>
              <button className="action-button" type="button" onClick={() => reset()}>
                Try again
              </button>
            </p>
            <Link className="text-link" href="/">Return home</Link>
          </section>
        </main>
      </body>
    </html>
  );
}
