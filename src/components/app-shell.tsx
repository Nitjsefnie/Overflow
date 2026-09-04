import Link from "next/link";
import type { ReactNode } from "react";

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
          <ul className="site-nav">
            <li>
              <Link href="/dashboard">Ledger</Link>
            </li>
            <li>
              <Link href="/issues">Issues</Link>
            </li>
            <li>
              <Link href="/repositories/new">Register a repository</Link>
            </li>
            <li>
              <Link href="/calibration">Calibration</Link>
            </li>
            {isModerator ? (
              <li>
                <Link href="/moderation">Moderation</Link>
              </li>
            ) : null}
          </ul>
        </nav>
        <p className="member-stamp">
          Signed in as <span>{memberName}</span>
        </p>
      </header>
      <main id="main-content" className="page-content">
        {children}
      </main>
      <footer className="site-footer">
        <p>Overflow keeps cooperative promises legible.</p>
      </footer>
    </div>
  );
}
