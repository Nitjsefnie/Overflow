import Link from "next/link";
import type { ReactNode } from "react";
import { signOutAction } from "@/lib/auth/sign-out-action";

type AppShellProps = {
  memberName: string;
  isModerator: boolean;
  children: ReactNode;
};

export function AppShell({ memberName, isModerator, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <Link className="wordmark" href="/dashboard" aria-label="Overflow dashboard">
          <span className="mark" aria-hidden="true" />
          <span>Overflow</span>
        </Link>
        <nav aria-label="Member navigation">
          {/* The account-data notice is deliberately NOT in this list. The
              header contract is measured: the moderator nav (the widest
              Overflow ships) fills the middle column to 749.5px of its 757.9px
              at every desktop width, so a ninth link — any ninth link, given
              the 16px column gap — wraps inside the column and re-creates the
              issue-40 defect. The notice links from the footer instead, and
              scripts/measure-header-geometry.mjs holds the line if this list
              ever changes. */}
          <ul className="site-nav">
            <li>
              <Link href="/dashboard">Ledger</Link>
            </li>
            <li>
              <Link href="/issues">Issues</Link>
            </li>
            <li>
              <Link href="/settlements">Settlements</Link>
            </li>
            <li>
              <Link href="/members">Members</Link>
            </li>
            <li>
              <Link href="/repositories/new">Register a repository</Link>
            </li>
            <li>
              <Link href="/calibration">Calibration</Link>
            </li>
            <li>
              <Link href="/rules">Rules</Link>
            </li>
            {isModerator ? (
              <li>
                <Link href="/moderation">Moderation</Link>
              </li>
            ) : null}
          </ul>
        </nav>
        <div className="session-controls">
          <p className="member-stamp">
            Signed in as <span>{memberName}</span>
          </p>
          <form action={signOutAction}>
            <button className="quiet-button" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main id="main-content" className="page-content">
        {children}
      </main>
      <footer className="site-footer">
        <p>Overflow keeps cooperative promises legible.</p>
        <p>
          <Link href="/account-data">Account data</Link>
        </p>
      </footer>
    </div>
  );
}

type PublicAppShellProps = {
  children: ReactNode;
};

/**
 * The site chrome for the signed-out entry point: the same header, navigation
 * and footer skeleton AppShell renders, without the session controls, and with
 * the wordmark linking the public entry instead of the dashboard. The page
 * supplies its own main element (the landing view renders main.landing-page),
 * so this shell adds no main of its own — the skip link targets the page's.
 */
export function PublicAppShell({ children }: PublicAppShellProps) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="Overflow home">
          <span className="mark" aria-hidden="true" />
          <span>Overflow</span>
        </Link>
        <nav aria-label="Site navigation">
          {/* Every link here must point at a route that renders for a
              signed-out visitor. / is carried by the wordmark (/session is a
              recovery surface, not a destination); /account-data is the one
              proven-public route in this list — a static page with no session
              read, proved by tests/components/account-data-page.test.tsx. */}
          <ul className="site-nav">
            <li>
              <Link href="/account-data">Account data</Link>
            </li>
          </ul>
        </nav>
      </header>
      {children}
      <footer className="site-footer">
        <p>Overflow keeps cooperative promises legible.</p>
        <p>
          <Link href="/account-data">Account data</Link>
        </p>
      </footer>
    </div>
  );
}
