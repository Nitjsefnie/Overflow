import Link from "next/link";
import { signOutAction } from "@/lib/auth/sign-out-action";

type SessionRecoveryProps = {
  reason: string | undefined;
};

type SessionPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export function SessionRecovery({ reason }: SessionRecoveryProps) {
  return (
    <main className="landing-page">
      <section className="empty-state" aria-labelledby="session-recovery-title">
        <p className="eyebrow">Session recovery</p>
        {reason === "unavailable" ? (
          <>
            <h1 id="session-recovery-title">The ledger could not be reached.</h1>
            <p>
              Your sign-in is still valid. Overflow could not read your member record, so no protected page can
              load until the ledger answers again.
            </p>
            <Link className="text-link" href="/dashboard">
              Try the ledger again
            </Link>
          </>
        ) : (
          <>
            <h1 id="session-recovery-title">Overflow no longer recognises this account.</h1>
            <p>
              This browser still holds a sign-in that matches no member record. Clear the session, then sign in
              again.
            </p>
          </>
        )}
        <form action={signOutAction}>
          <button className="action-button" type="submit">
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}

export default async function SessionPage({ searchParams }: SessionPageProps = {}) {
  const query = searchParams === undefined ? {} : await searchParams;
  const reason = query.reason;
  return <SessionRecovery reason={typeof reason === "string" ? reason : undefined} />;
}
