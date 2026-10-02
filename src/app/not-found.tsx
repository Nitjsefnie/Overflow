import Link from "next/link";
import { PublicAppShell } from "@/components/app-shell";

/**
 * Issue 908: src/app shipped error.tsx and global-error.tsx but no
 * not-found.tsx, so an unknown URL rendered Next.js's own 404 — unstyled, no
 * app shell, and failing the landmark-one-main and region checks. This composes
 * the public shell the other signed-out routes use, because the page is served
 * to whoever mistyped the address regardless of session.
 *
 * The shell adds no main of its own, so the content supplies
 * main.landing-page#main-content — the element the shell's skip link targets.
 * ErrorFallback is not reused: its reset callback is required for a retry a
 * dead address has no use for, its copy is error-specific, and its main
 * carries no id.
 */
export default function NotFound() {
  return (
    <PublicAppShell>
      <main className="landing-page" id="main-content">
        <section className="landing-hero" aria-labelledby="not-found-title">
          <p className="eyebrow">Overflow</p>
          <h1 id="not-found-title">This address does not exist.</h1>
          <p className="landing-lede">
            Nothing is served here. The page may have moved, or the link that brought you here may be
            out of date.
          </p>
          <Link className="text-link" href="/">
            Return to the home page
          </Link>
        </section>
      </main>
    </PublicAppShell>
  );
}
