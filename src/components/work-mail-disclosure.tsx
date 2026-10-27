import Link from "next/link";
import { readContributorMailConfig } from "@/lib/accounts/work-mail-config";

// Only the From address and the host are rendered: the SMTP URL carries the username and password.
function sendingIdentity(): { from: string; host: string } | null {
  const config = readContributorMailConfig();
  return config.enabled ? { from: config.from, host: config.smtp.host } : null;
}

/** The account-data notice's section on the opt-in work-mail address, rendered from this copy's configuration. */
export function WorkMailDisclosure() {
  const sending = sendingIdentity();
  return (
    <section
      className="surface"
      aria-labelledby="account-data-work-mail-heading"
      data-work-mail={sending === null ? "off" : "on"}
    >
      <h2 id="account-data-work-mail-heading">Work notification mail</h2>
      {sending === null ? (
        <p>
          This copy of Overflow sends no work notification mail: its operator has not configured a valid sending
          identity, mail server and daily limit for it, so your dashboard offers no form to add an address, and
          Overflow reads no email address from GitHub or GitLab.
        </p>
      ) : (
        <>
          <p>
            You can ask to be emailed when there is work to take by typing an address into the work-mail panel of
            your <Link href="/dashboard">dashboard</Link>. You type the address in yourself: Overflow reads none
            from GitHub or GitLab. No work notification is sent to it until you open
            the confirmation link mailed to it, which works for 24 hours, and at most three confirmation mails go out
            per account and per address in any 24 hours.
          </p>
          <p>
            Once confirmed, the address is used for one purpose: at most one mail per 24 hours, sent only when issues
            your issues board lists as open to claim have newly appeared since your last one, or since you confirmed.
            The mail states how many and links to the board; it carries no issue text, and every such mail has a
            one-click unsubscribe link.
          </p>
        </>
      )}
      <p>
        For an address you add, Overflow stores the address, when you asked, when its confirmation link expires, when
        you confirmed it, and when you were last mailed. For each confirmation mail it also keeps a history row: a
        keyed digest of the address — not the address itself — and the time it was sent, used only to enforce the
        limit on confirmation mails. The address is shown only to you, in your dashboard&apos;s work-mail panel, and
        your account export contains the address, its times and your confirmation history.
      </p>
      <p>
        The address is kept until you remove it — in that panel, which your dashboard shows while an address is
        stored, or through a mail&apos;s unsubscribe link — or delete your account; either deletes it at once. An
        address never confirmed is deleted by the first automated retention prune after its confirmation link
        expires; the prune runs every six hours. History rows are deleted by that prune once they are more than 24 hours old:
        removing the address keeps them until then, so removing and re-adding it cannot reset the limit, while
        deleting your account deletes them at once.
      </p>
      {sending === null ? null : (
        <p>
          Mail is sent from <span data-work-mail-from>{sending.from}</span> and submitted over an encrypted
          connection to the mail server at <span data-work-mail-host>{sending.host}</span>, whose operator receives
          your address and each message (see Recipients and transfers below). Replies to it are not a request channel
          and are not read: requests go through the GitHub routes under Controller and contact above — the public
          issue tracker and the private reporting form — or, where this copy&apos;s operator configured other
          channels, through those.
        </p>
      )}
    </section>
  );
}

/** The recipients-list entry for the configured mail server; nothing while this copy sends no work mail. */
export function WorkMailRecipient() {
  const sending = sendingIdentity();
  return sending === null ? null : (
    <li>
      the operator of the mail server at <span data-work-mail-host>{sending.host}</span> — work notification mail you
      opt in to is submitted there for delivery, so it receives your address and each message. Which provider runs
      that server, and where, is this copy&apos;s configuration, so no region or transfer mechanism is documented
      for it
    </li>
  );
}
