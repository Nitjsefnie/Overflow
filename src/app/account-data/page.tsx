import { PublicAppShell } from "@/components/app-shell";

export function AccountDataNotice() {
  return (
    <main className="page-content" id="main-content">
      <section className="page-heading" aria-labelledby="account-data-title">
        <h1 id="account-data-title">Account data</h1>
        <p>What Overflow stores when you sign in with GitHub, what it is used for, and what you control.</p>
      </section>

      <section className="surface" aria-labelledby="account-data-stored-heading">
        <h2 id="account-data-stored-heading">What sign-in stores</h2>
        <p>
          Signing in with GitHub creates one account row in Overflow&apos;s database. The sign-in asks GitHub for
          exactly one permission — the <code>admin:repo_hook</code> scope — and reads only the public fields of
          GitHub&apos;s <code>/user</code> endpoint: your numeric GitHub user id, your login, and your avatar URL.
          Overflow reads no email address anywhere: it requests no email scope and reads no email endpoint.
        </p>
        <ul>
          <li>your GitHub user id, login, and avatar URL</li>
          <li>the role Overflow assigns you — MEMBER or MODERATOR</li>
          <li>an enforcement state and a confirmed-miscalibration count, which moderation uses</li>
          <li>the row&apos;s creation and last-update timestamps</li>
          <li>
            Overflow&apos;s OAuth access token for your GitHub account, encrypted with a server-side key before it
            is stored
          </li>
        </ul>
        <p>Overflow runs no analytics and no advertising scripts.</p>
      </section>

      <section className="surface" aria-labelledby="account-data-usage-heading">
        <h2 id="account-data-usage-heading">What the token is used for</h2>
        <p>
          On repositories you administer, the token reads repository and difficulty-label data, and creates or
          deletes Overflow&apos;s webhook when you register or unregister a repository. These are the flows you
          trigger. The token is never displayed in the product.
        </p>
      </section>

      <section className="surface" aria-labelledby="account-data-access-heading">
        <h2 id="account-data-access-heading">Who can see it</h2>
        <p>The site operator administers Overflow&apos;s database and the token&apos;s encryption key.</p>
        <p>
          Other signed-in members and moderators see your GitHub login and avatar: Overflow&apos;s member roster and
          moderation surfaces display them.
        </p>
      </section>

      <section className="surface" aria-labelledby="account-data-retention-heading">
        <h2 id="account-data-retention-heading">How long it is kept</h2>
        <ul>
          <li>The account row persists while your account exists; nothing expires automatically.</li>
          <li>
            Signed-in state is a signed JWT cookie, and Overflow keeps no server-side session rows. Signing out
            clears that cookie and nothing else.
          </li>
          <li>
            Revoking the authorization on GitHub makes the stored token unusable at its next use. It does not delete
            your account row.
          </li>
        </ul>
      </section>

      <section className="surface" aria-labelledby="account-data-controls-heading">
        <h2 id="account-data-controls-heading">Your controls</h2>
        <ul>
          <li>
            Revoke Overflow&apos;s authorization at{" "}
            <a href="https://github.com/settings/applications" rel="noreferrer">
              github.com/settings/applications
            </a>{" "}
            — the next sign-in re-requests it.
          </li>
          <li>
            Request deletion of your account row, or an export of its stored fields, by opening an issue at{" "}
            <a href="https://github.com/Nitjsefnie/Overflow/issues" rel="noreferrer">
              github.com/Nitjsefnie/Overflow/issues
            </a>{" "}
            or by contacting the operator.
          </li>
        </ul>
      </section>

      <section className="surface" aria-labelledby="account-data-deletion-heading">
        <h2 id="account-data-deletion-heading">What deletion means</h2>
        <p>Deleting the account row removes the identity fields and the stored token.</p>
        <p>
          Historical ledger records that reference your GitHub identity — cooperative records of work on the
          repositories involved — are part of the shared ledger. Deleting your account does not rewrite them.
        </p>
      </section>
    </main>
  );
}

export default function AccountDataPage() {
  return (
    <PublicAppShell>
      <AccountDataNotice />
    </PublicAppShell>
  );
}
