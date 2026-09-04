import { signIn } from "@/auth";
import { redirect } from "next/navigation";

async function signInWithGitHub() {
  "use server";
  await signIn("github");
}

export function LandingPage() {
  return (
    <main className="landing-page">
      <section className="landing-hero" aria-labelledby="landing-title">
        <p className="eyebrow">A cooperative ledger for open-source work</p>
        <h1 id="landing-title">Cooperative credit for open-source work.</h1>
        <p className="landing-lede">
          Overflow records completed contributions, visible proof, and the credit that moves between maintainers
          and contributors.
        </p>
        <form action={signInWithGitHub}>
          <button className="action-button" type="submit">
            Sign in with GitHub
          </button>
        </form>
      </section>
      <section className="landing-principles" aria-label="How Overflow works">
        <article>
          <h2>Promises are explicit</h2>
          <p>Each repository chooses its own opening and actual catalog language.</p>
        </article>
        <article>
          <h2>Proof closes the loop</h2>
          <p>Linked GitHub issues and pull requests show why a settlement moved.</p>
        </article>
        <article>
          <h2>Calibration stays accountable</h2>
          <p>Samples compare self-work with outsider settlements without turning people into a retention metric.</p>
        </article>
      </section>
    </main>
  );
}

export default async function HomePage() {
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown; role?: unknown } | undefined;
  if (typeof user?.id === "string" && (user.role === "MEMBER" || user.role === "MODERATOR")) {
    redirect("/dashboard");
  }
  return <LandingPage />;
}
