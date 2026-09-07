import Link from "next/link";

export default function ErrorFallback({ digest, reset, headingId }: {
  digest?: string;
  reset: () => void;
  headingId: string;
}) {
  return (
    <main className="landing-page">
      <section className="landing-hero" aria-labelledby={headingId}>
        <p className="eyebrow">Overflow</p>
        <h1 id={headingId}>Something went wrong.</h1>
        <p className="landing-lede">Please try again, or return to the home page.</p>
        {digest && (
          <p className="proof-fingerprint">Error reference: <code>{digest}</code></p>
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
