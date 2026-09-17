import { PublicAppShell } from "@/components/app-shell";

export function AccountDataNotice() {
  return (
    <main className="page-content" id="main-content">
      <section className="page-heading" aria-labelledby="account-data-title">
        <h1 id="account-data-title">Account data</h1>
        <p>
          What Overflow stores when you sign in with GitHub or link a GitLab identity, what it is used for, and
          what you control.
        </p>
      </section>

      <section className="surface" aria-labelledby="account-data-stored-heading">
        <h2 id="account-data-stored-heading">What sign-in and linking store</h2>
        <p>You sign in with GitHub and can also link a GitLab identity for each GitLab instance you use.</p>
        <p>
          Signing in with GitHub creates one account row in Overflow&apos;s database. The sign-in reads only the
          public fields of GitHub&apos;s <code>/user</code> endpoint: your numeric GitHub user id, your login, and
          your avatar URL. Which permission it asks GitHub for depends on the sign-in you choose. Signing in to
          contribute requests no permission at all. Signing in to register a repository requests exactly one — the{" "}
          <code>admin:repo_hook</code> scope, which creating and removing Overflow&apos;s webhook on a repository you
          administer needs — and a contributor who later registers a repository is asked for that one scope then.
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
        <p>
          To link GitLab, submit your instance URL and a personal access token created on that instance in your
          dashboard&apos;s forge-identities panel. Overflow stores each identity by its instance and GitLab account,
          whether you use gitlab.com or a self-hosted instance. You can link several GitLab accounts on the same
          instance. For each identity, Overflow stores:
        </p>
        <ul>
          <li>the instance&apos;s base URL, such as https://gitlab.com, without any extra path</li>
          <li>your numeric GitLab user id and your GitLab login, which is used only for display</li>
          <li>
            your personal access token, encrypted with Overflow&apos;s server-side key before storage, using the
            same encryption as your GitHub token
          </li>
          <li>when you linked the identity and when linking or re-linking last successfully verified it</li>
          <li>
            when Overflow last recorded a rejected background reconciliation read on the instance, if any; it
            tries to update this time on all your GitLab identities on that instance after each such rejection,
            even if their tokens work. This time does not identify which token was used. A successful re-link
            clears it for the re-linked identity
          </li>
        </ul>
        <p>
          Before storing anything, Overflow asks the instance which read permissions the token has, falling back
          to trying a read that requires those permissions, and asks the instance who the token belongs to. If the
          instance rejects the token or it lacks the read permissions reconciliation needs, nothing is stored.
          The same GitLab identity can belong to only one Overflow account; linking it to a second account is
          refused. Overflow reads no GitLab email address.
        </p>
        <p>Overflow runs no analytics and no advertising scripts.</p>
      </section>

      <section className="surface" aria-labelledby="account-data-usage-heading">
        <h2 id="account-data-usage-heading">What the tokens are used for</h2>
        <p>
          When you register or unregister a repository, the token creates or deletes Overflow&apos;s webhook on it —
          before creating one, Overflow asks GitHub which permissions the token holds and refuses a token without
          webhook administration — and a labels lookup runs on any GitHub repository path you submit during
          registration or catalog flows.
          Overflow&apos;s reconciliation re-reads the registered repository&apos;s issues, pull requests, reviews,
          and diffs — when you register or change a repository, and unattended, as a periodic sweep keeps the
          ledger current — using that repository&apos;s sponsor token. The token is never displayed in the product.
        </p>
        <p>
          For GitLab repositories, Overflow decrypts the stored personal access token for each use. Reads during
          registration and the labels lookup when you submit a GitLab repository path use your own linked identity
          for that instance. Creating and removing webhooks during registration and unregistration, and background
          reconciliation reads — periodic sweeps, initial imports, and webhook-triggered updates — use the token
          of the account that registered the repository — its sponsor. Overflow selects one linked identity
          belonging to the relevant account on that instance, without checking its access or guaranteeing which
          identity is chosen. It does not automatically try the others if that token fails. Keeping a second,
          working identity linked does not guarantee reconciliation keeps working. The token is never displayed
          or included in any response from Overflow.
        </p>
        <p>
          Linking claims your eligible past unclaimed GitLab settlements. Ongoing reconciliation credits GitLab
          contributions to your Overflow account through your linked numeric GitLab user id.
        </p>
      </section>

      <section className="surface" aria-labelledby="account-data-access-heading">
        <h2 id="account-data-access-heading">Who can see it</h2>
        <p>The site operator administers Overflow&apos;s database and the token&apos;s encryption key.</p>
        <p>
          Other signed-in members and moderators see your GitHub login — the member roster and the moderation
          surfaces display it. Your avatar URL is stored but not displayed.
        </p>
        <p>
          Your linked GitLab identities are shown only to you in your dashboard&apos;s forge-identities panel,
          which displays each identity&apos;s instance URL, login, and last-verified date, and warns of a recorded
          rejected background reconciliation read. Other members and moderators still see only your GitHub login.
          The stored GitLab token is displayed to no one.
        </p>
      </section>

      <section className="surface" aria-labelledby="account-data-retention-heading">
        <h2 id="account-data-retention-heading">How long it is kept</h2>
        <ul>
          <li>The account row persists while your account exists; nothing expires automatically.</li>
          <li>
            Signed-in state is a signed JWT cookie, and Overflow keeps no server-side session rows. Besides your
            identity, the cookie records whether the permissions GitHub granted at sign-in include webhook
            administration, which decides whether the registration page shows its form. Signing out clears that
            cookie and nothing else.
          </li>
          <li>
            Revoking the authorization on GitHub makes the stored token unusable at its next use. It does not delete
            your account row.
          </li>
          <li>Your linked GitLab identities persist while your account exists; nothing expires automatically.</li>
          <li>
            Revoking a personal access token on its GitLab instance makes Overflow&apos;s stored copy unusable at
            its next use. It does not delete the linked identity. Only rejected background reconciliation reads —
            periodic sweeps, initial imports, and webhook-triggered updates — cause Overflow to try to record or
            update the failure time on all your GitLab identities on that instance, including repeated failures
            and identities whose tokens work. Other rejected reads and webhook operations surface an error
            without recording a failure time; the labels lookup error tells you to re-link.
          </li>
          <li>
            Re-linking refreshes the stored token, updates the last successful verification time, and clears the
            failure time. Only linking and re-linking update the successful verification time.
          </li>
          <li>Unlinking immediately deletes the linked identity&apos;s fields and encrypted token.</li>
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
            Link, re-link, or unlink a GitLab identity in your dashboard&apos;s forge-identities panel. Unlinking
            immediately removes Overflow&apos;s stored identity fields and encrypted token. It does not revoke or
            delete the token on your GitLab instance.
          </li>
          <li>
            Unlinking does not unregister repositories registered under that identity. A registration without a
            webhook can be unregistered without a token. Removing an existing webhook and background reconciliation
            reads need the selected sponsor identity&apos;s token to have the required access. Overflow does not
            automatically try another linked identity if that token fails, so linking another GitLab account with
            access may not restore these operations.
          </li>
          <li>
            To revoke a GitLab token, delete it yourself in your instance&apos;s personal access tokens settings.
            Overflow&apos;s stored copy then fails at its next use. Only a rejected background reconciliation read
            causes Overflow to try to record the failure time on all your GitLab identities on that instance.
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
          Overflow cannot delete your account while it still holds a linked GitLab identity. Unlink every GitLab
          identity before deleting your account.
        </p>
        <p>
          Historical ledger records that reference your GitHub identity — cooperative records of work on the
          repositories involved — are part of the shared ledger. Deleting your account does not rewrite them.
        </p>
        <p>
          Historical ledger records that reference your GitLab identity are also part of the shared ledger and
          are not rewritten when you delete your account.
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
