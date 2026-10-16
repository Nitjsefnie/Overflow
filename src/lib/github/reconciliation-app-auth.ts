import type { AppInstallationTokenResolver } from "@/lib/github/app-installation-auth";
import type { RegisteredRepository } from "@/lib/repositories/register";

/** Route each registration to its own App, keeping OAuth fallback in the fold. */
export function createReconciliationAppTokenResolver(options: {
  lookupRegistrationMethod(ownerName: string): Promise<RegisteredRepository["registrationMethod"] | null>;
  ledgerResolver: AppInstallationTokenResolver | null;
  registrationResolver: AppInstallationTokenResolver | null;
}): AppInstallationTokenResolver | undefined {
  if (options.ledgerResolver === null && options.registrationResolver === null) return undefined;
  return async (ownerName) => {
    const method = await options.lookupRegistrationMethod(ownerName);
    const app = method === "app" ? "registration" : "ledger";
    const resolver = app === "registration" ? options.registrationResolver : options.ledgerResolver;
    const result = await resolver?.(ownerName) ?? null;
    return result === null ? null : { ...result, app };
  };
}
