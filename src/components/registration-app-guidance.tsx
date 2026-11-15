import type { RegistrationAppInstall } from "@/lib/github/registration-app-display";

export type RegistrationAppDisplayProps = {
  registrationAppConfigured?: boolean;
  registrationAppInstall?: RegistrationAppInstall | null;
};

export function RegistrationAppHelp({ install }: { install: RegistrationAppInstall | null }) {
  return <p className="field-help">
    Install this instance&apos;s registration App{install === null ? null : <>, <a href={install.url}>{install.slug}</a>,</>}{" "}
    on the public repositories you want to register, then come back to this page and register each one here.{" "}
    If you cannot install it on the repository&apos;s account, ask that account&apos;s owner to install it.{" "}
    Sign-in uses public identity only; no webhook-administration scope is requested.
    {install === null ? " Ask this instance's operator for the App's install link." : null}
  </p>;
}

export function RegistrationAppAlternative({ install }: { install: RegistrationAppInstall | null }) {
  return <p>
    Or register through this instance&apos;s registration App, which needs no <code>admin:repo_hook</code> permission:{" "}
    {install === null ? "install it" : <a href={install.url}>install it</a>} on the repository, choose &quot;GitHub App&quot; as the{" "}
    registration method above, and register.
  </p>;
}
