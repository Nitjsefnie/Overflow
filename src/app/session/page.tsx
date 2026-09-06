import Link from "next/link";
import { signOutAction } from "@/lib/auth/sign-out-action";
import {
  SESSION_RECOVERY_REASONS,
  toSessionRecoveryReason,
  type SessionRecoveryReason,
} from "@/lib/auth/session-recovery-reasons";

type SessionRecoveryProps = {
  reason: SessionRecoveryReason | undefined;
};

type SessionPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export function SessionRecovery({ reason }: SessionRecoveryProps) {
  return (
    <main className="landing-page">
      <section className="empty-state" aria-labelledby="session-recovery-title">
        <p className="eyebrow">Session recovery</p>
        {reason === SESSION_RECOVERY_REASONS.unavailable ? (
          <>
            <h1 id="session-recovery-title">The ledger could not be reached.</h1>
            <p>
              If you were signed in, that sign-in is still valid. Overflow could not read your member record,
              so no protected page can load until the ledger answers again.
            </p>
            <Link className="text-link" href="/dashboard">
              Try the ledger again
            </Link>
          </>
        ) : (
          <>
            <h1 id="session-recovery-title">Clear this sign-in and start again.</h1>
            <p>
              If you were signed in, that sign-in no longer matches a member record. Sign out to clear it, then
              sign in again.
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

export default async function SessionPage({ searchParams }: SessionPageProps) {
  const query = await searchParams;
  return <SessionRecovery reason={toSessionRecoveryReason(query.reason)} />;
}
