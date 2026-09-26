import Link from "next/link";
import { PublicAppShell } from "@/components/app-shell";

export function AccountDataNotice() {
  return (
    <main className="page-content" id="main-content">
      <section className="page-heading" aria-labelledby="account-data-title">
        <h1 id="account-data-title">Account data</h1>
        <p>
          What Overflow stores when you sign in with GitHub or link a GitLab identity, what it is used for, and
          what you control — and what it stores about people who have never signed in, and what its server logs
          record.
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
            when Overflow last recorded a rejected background reconciliation read made through this identity&apos;s
            token, if any. Reads through other identities are not recorded here. A successful re-link clears it
            for the re-linked identity
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
          belonging to the relevant account on that instance, preferring identities without a recorded failure
          and choosing the most recently verified among them. If the instance rejects a read for authentication
          or access during background reconciliation, Overflow tries to record the failure on the identity
          whose token was used.
          That operation fails without trying another token. Once the rejection is successfully recorded, later
          operations prefer identities without a recorded failure, so an already-linked working identity on the same
          Overflow account and instance can restore later operations. If recording fails, the rejected identity can
          be selected again. Newly linking or successfully re-linking a working identity on that account and instance
          refreshes its verification time and leaves it without a recorded failure, making it the preferred identity.
          This can restore later operations; the rejected operation still fails. The token is never
          displayed or included in any response from Overflow.
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
          surfaces display it. Your avatar URL is stored and included in your account-data export (which only
          you see); it is not displayed to other members.
        </p>
        <p>
          Your linked GitLab identities are shown only to you in your dashboard&apos;s forge-identities panel,
          which displays each identity&apos;s instance URL, login, and last-verified date, and warns of a recorded
          rejected background reconciliation read. Other members and moderators still see only your GitHub login.
          The stored GitLab token is displayed to no one.
        </p>
      </section>

      <section className="surface" aria-labelledby="account-data-non-member-heading">
        <h2 id="account-data-non-member-heading">People who have never signed in</h2>
        <p>
          Overflow reads each registered repository&apos;s issues, pull requests, and comments from GitHub or
          GitLab using the token of the member who registered it — its sponsor. So it stores data about people who
          took part in that repository without ever signing in to Overflow. GitLab usernames and numeric user ids
          are stored the same way as GitHub logins and ids.
        </p>
        <p>What it stores about them:</p>
        <ul>
          <li>
            the login of the author of an issue Overflow tracks — only an issue carrying one of the
            repository&apos;s opening catalog labels can be tracked — and the login and numeric user id of an
            issue&apos;s claim assignee and of a pull request&apos;s author
          </li>
          <li>
            for work credited to someone with no Overflow account, a settlement holding that person&apos;s login
            and numeric user id
          </li>
          <li>the titles, URLs, and states of the issues and pull requests it records</li>
          <li>
            a cache per registered repository holding every issue in it, not only tracked ones: each issue&apos;s
            title, author, assignee, and the history of who labelled and assigned it; every comment on it, with
            its author&apos;s login and numeric user id; and the title and author of each pull request that
            closes it. For each of those closing pull requests that was merged in the registered repository, the
            cache also keeps its diff and its reviews — without the reviewer&apos;s login or text — because
            settlement proofs are computed from them: the proof is a SHA-256 of the diff
          </li>
          <li>a change log recording logins and titles as those records change</li>
          <li>moderation notes, which can name the account that applied a label</li>
        </ul>
        <p>
          None of the free text is retained: a reconciliation pass writes no issue, pull request, or comment
          body text, and unregistering a repository scrubs what earlier passes stored.
        </p>
        <p>Overflow stores no avatar and no display name for someone who has not signed in.</p>
        <p>
          Nothing about a person who has not signed in is shown to a visitor who is not signed in. Signed-in
          members see a claim assignee&apos;s login and issue titles on the issues board. A repository&apos;s
          sponsor sees the claim assignees on its dashboard, and issue titles, often with pull request titles, on
          its dashboard, settlement history, and settlement proof and calibration pages; a member credited with a
          settlement sees the same titles on their own dashboard and settlement history and on that
          settlement&apos;s proof page. Moderators see the moderation notes, and issue and pull request titles in
          the moderation queues and closure history. Descriptions, comment text, the cache, and the change log
          are displayed to no one. The site operator administers the database.
        </p>
        <p>How long it is kept:</p>
        <ul>
          <li>
            While the repository stays registered, reconciliation re-reads it. A pass re-reads from GitHub or
            GitLab only the issues updated since the last pass and takes the rest from the cache; a full re-read
            replaces the whole cache. Each pass overwrites the stored logins and pull request fields from that
            copy, and an issue&apos;s title and description whenever the forge&apos;s copy is at least as new. An
            unattended sweep runs every six hours, and a pass does a full re-read once six hours have passed since
            the last one, so while the repository can still be read, an edit or deletion on GitHub or GitLab
            normally reaches Overflow&apos;s copy within twelve hours. An issue or pull request that a later pass
            no longer records is removed.
          </li>
          <li>
            If the repository itself is deleted, made private, or can no longer be read with its sponsor&apos;s
            token, the re-reads stop while it stays that way and nothing is deleted: the stored copy is kept.
            Once the repository can be read again, the re-reads resume.
          </li>
          <li>
            The change log is append-only: Overflow itself never deletes the logins and titles it recorded,
            including those of removed issues and pull requests. The operator has a cleanup script, run by hand,
            that removes only entries recording no actual change.
          </li>
          <li>
            Unregistering a repository deletes none of this. It stops the re-reads, so the copy stored for that
            repository is kept indefinitely.
          </li>
          <li>The daily database backups described in the How long it is kept section below hold this data too.</li>
        </ul>
        <p>
          To ask for data about you to be removed, open an issue at{" "}
          <a href="https://github.com/Nitjsefnie/Overflow/issues" rel="noreferrer">
            github.com/Nitjsefnie/Overflow/issues
          </a>{" "}
          from the account the request is about. No private channel exists, and opening an issue needs a GitHub
          account. Overflow has no removal feature for people who have not signed in, so the operator handles a
          request by hand. Content still on GitHub or GitLab in a registered repository is read again at the next
          pass, so removing it there first is what keeps it out of Overflow.
        </p>
      </section>

      <section className="surface" aria-labelledby="account-data-logs-heading">
        <h2 id="account-data-logs-heading">Server logs</h2>
        <p>This applies to every visitor, signed in or not.</p>
        <p>
          The web server in front of Overflow logs every request: the client&apos;s IP address — the real address,
          restored from Cloudflare&apos;s forwarding header — the time, the requested path, the response status,
          the referring page, and the browser&apos;s user agent. That log is shared by every site on the host. It
          is kept for 14 rotations, normally one a day, so about 15 days in all; a log that stays empty rotates
          less often. The web server&apos;s error log also records the client&apos;s IP address for a request that
          hits an error; it is rotated and deleted the same way.
        </p>
        <p>
          Overflow&apos;s own output goes to the host&apos;s system journal. The journal has no time limit, only a
          size limit shared with every other service on the host, so how long an entry lasts depends on how much
          the host logs overall. Overflow does not log client IP addresses. Its log lines can include a
          repository&apos;s owner and name, which may be a person&apos;s username, and error details; a database
          or forge error can quote part of the record being written or read, such as an issue description or
          comment text.
        </p>
      </section>

      <section className="surface" aria-labelledby="account-data-retention-heading">
        <h2 id="account-data-retention-heading">How long it is kept</h2>
        <ul>
          <li>
            The account row persists while your account exists, and deleting your account pseudonymises
            the row rather than removing it; the row never expires automatically.
          </li>
          <li>
            Signed-in state is an encrypted cookie — a JSON Web Encryption token, not a plain signed JWT — which
            expires after 30 days, and Overflow keeps no server-side session rows. The cookie records the identity
            the sign-in read from GitHub — your login and your avatar URL — together with Overflow&apos;s own
            reference to your account and your role, when you last completed a GitHub sign-in, and whether the
            permissions GitHub granted at sign-in include webhook administration, which decides whether the
            registration page shows its form. Signing out clears that cookie and nothing else.
          </li>
          <li>
            Revoking the authorization on GitHub makes the stored token unusable at its next use. It does not delete
            your account row.
          </li>
          <li>
            Your linked GitLab identities persist while your account exists, and deletion keeps them; they
            never expire automatically.
          </li>
          <li>An API token expires 90 days after it is issued; deletion removes it at once.</li>
          <li>
            Revoking a personal access token on its GitLab instance makes Overflow&apos;s stored copy unusable at
            its next use. It does not delete the linked identity. Only rejected background reconciliation reads —
            periodic sweeps, initial imports, and webhook-triggered updates — cause Overflow to try to record or
            update the failure time on the identity whose token was used for the read, including repeated failures.
            Other rejected reads and webhook operations surface an error
            without recording a failure time; the labels lookup error tells you to re-link.
          </li>
          <li>
            Re-linking refreshes the stored token, updates the last successful verification time, and clears the
            failure time. Only linking and re-linking update the successful verification time.
          </li>
          <li>Unlinking immediately deletes the linked identity&apos;s fields and encrypted token.</li>
          <li>
            Daily database backups taken before a deletion keep pre-deletion data on the same host as the
            database. Each backup is pruned once it is more than 14 days old — in practice about 15 days —
            and pruning happens only after a later backup succeeds, so failing backups keep them longer.
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
            Link, re-link, or unlink a GitLab identity in your dashboard&apos;s forge-identities panel. Unlinking
            immediately removes Overflow&apos;s stored identity fields and encrypted token. It does not revoke or
            delete the token on your GitLab instance.
          </li>
          <li>
            Unlinking does not unregister repositories registered under that identity. A registration without a
            webhook can be unregistered without a token. Removing an existing webhook and background reconciliation
            reads need the selected sponsor identity&apos;s token to have the required access. For each operation,
            Overflow prefers a linked identity without a recorded failure, choosing the most recently verified
            among those identities. A rejected background reconciliation read causes Overflow to try to record
            the failure on the identity whose token was used and fails that operation without trying another
            identity. Once the rejection is successfully recorded, later operations prefer identities without a
            recorded failure, so an already-linked working identity on the same account and instance can restore
            later operations. If recording fails, the rejected identity can be selected again. Newly linking or
            successfully re-linking a working identity on that account and instance refreshes its verification time
            and leaves it without a recorded failure, making it the preferred identity. This can restore later
            operations; the operation that hit the rejection still fails.
          </li>
          <li>
            To revoke a GitLab token, delete it yourself in your instance&apos;s personal access tokens settings.
            Overflow&apos;s stored copy then fails at its next use. Only a rejected background reconciliation read
            causes Overflow to try to record the failure time on the identity whose token was used.
          </li>
          <li>
            Download an export of the data stored about your account, or delete your account, from the
            &ldquo;Your account data&rdquo; section of your <Link href="/dashboard">dashboard</Link> — no
            public request is needed.
          </li>
          <li>
            If you cannot sign in to Overflow, request deletion or an export of the data stored about
            your account by opening an issue at{" "}
            <a href="https://github.com/Nitjsefnie/Overflow/issues" rel="noreferrer">
              github.com/Nitjsefnie/Overflow/issues
            </a>{" "}
            from the GitHub account the request is about. No private channel exists.
          </li>
          <li>
            An export contains the fields stored about your account — a stored secret appears only as
            present or absent, never as its value — each linked GitLab identity without its token, your
            API token&apos;s creation and expiry dates but never the token itself, and every record in the
            database that holds a link to your account. Records that name you only by your GitHub login or
            numeric id — issue claim assignments and who labelled an issue or wrote its rationale, for
            example — are not part of the export.
          </li>
          <li>
            Because the tracker is public, the operator replies in your issue with the export only after
            you accept a public reply there, and only when the export holds no records of you acting on
            other accounts — no moderation action you took, no audit report you filed or decided, no role
            change you made, no override decision you issued — and no audit reports filed about your
            account. When it cannot be posted, sign in with the same GitHub account and download it from
            the &ldquo;Your account data&rdquo; section of your dashboard; otherwise the export is held. A
            member who can sign in can download the export there in every case.
          </li>
        </ul>
      </section>

      <section className="surface" aria-labelledby="account-data-deletion-heading">
        <h2 id="account-data-deletion-heading">What deletion means</h2>
        <p>
          Deletion is pseudonymisation: the account row survives with the identifiers the shared ledger
          attributes work by, and nothing that would let anyone act as you survives with it.
        </p>
        <p>Deletion removes:</p>
        <ul>
          <li>your GitHub login, replaced with the placeholder (deleted account)</li>
          <li>your avatar URL</li>
          <li>Overflow&apos;s stored access token for your GitHub account</li>
          <li>your API token, if you have one</li>
          <li>
            each linked GitLab identity&apos;s personal access token and GitLab login, which the same
            placeholder replaces
          </li>
        </ul>
        <p>Deletion keeps, and why:</p>
        <ul>
          <li>
            the account&apos;s internal id, your numeric GitHub id, and each GitLab identity&apos;s instance
            and numeric GitLab id — the shared ledger attributes work by them — and the date you linked
            each identity
          </li>
          <li>
            your role and standing: the enforcement state and confirmed-miscalibration count moderation
            uses, the row&apos;s creation timestamp, and the stamp deletion writes. A moderator stays a moderator
            unless the role is revoked
          </li>
          <li>
            every ledger record, including their copies of your public GitHub login, which later
            reconciliations keep refreshing from GitHub
          </li>
        </ul>
        <p>What happens afterwards:</p>
        <ul>
          <li>
            a deletion from your dashboard signs that browser out at once; any other signed-in session
            ends at its next request whose account lookup succeeds, and until then member pages and the
            member routes that re-read the account from the database refuse it. Your API token stops working
            at once
          </li>
          <li>
            signing in with GitHub again registers the account again and re-links the retained history;
            each GitLab identity must then be linked again from your dashboard
          </li>
        </ul>
        <p>Preconditions and limits:</p>
        <ul>
          <li>
            Overflow refuses to delete an account that still sponsors a registered repository. Unregister the
            repository from your dashboard first.
          </li>
          <li>
            Deletion does not revoke Overflow&apos;s authorization on GitHub. Revoke it yourself at{" "}
            <a href="https://github.com/settings/applications" rel="noreferrer">
              github.com/settings/applications
            </a>
            .
          </li>
        </ul>
        <p>
          To delete your account, use the &ldquo;Your account data&rdquo; section of your{" "}
          <Link href="/dashboard">dashboard</Link>: deletion there confirms a fresh GitHub sign-in
          first, and refuses while your account still sponsors a registered repository.
        </p>
        <p>
          If you cannot sign in, request deletion by opening an issue at{" "}
          <a href="https://github.com/Nitjsefnie/Overflow/issues" rel="noreferrer">
            github.com/Nitjsefnie/Overflow/issues
          </a>
          .
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
