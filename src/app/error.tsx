"use client";

import Link from "next/link";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="landing-page">
      <section className="landing-hero" aria-labelledby="error-title">
        <p className="eyebrow">Overflow</p>
        <h1 id="error-title">Something went wrong.</h1>
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
  );
}
