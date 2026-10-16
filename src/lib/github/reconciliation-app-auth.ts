import type { AppInstallationTokenResolver } from "@/lib/github/app-installation-auth";
import type { RegisteredRepository } from "@/lib/repositories/register";

/** Route each registration to its own App, keeping OAuth fallback in the fold. */
export function createReconciliationAppTokenResolver(options: {
  lookupRegistrationMethod(ownerName: string): Promise<RegisteredRepository["registrationMethod"] | null>;
  reconciliationResolver: AppInstallationTokenResolver | null;
  registrationResolver: AppInstallationTokenResolver | null;
}): AppInstallationTokenResolver | undefined {
  if (options.reconciliationResolver === null && options.registrationResolver === null) return undefined;
  return async (ownerName) => {
    const method = await options.lookupRegistrationMethod(ownerName);
    const app = method === "app" ? "registration" : "reconciliation";
    const resolver = app === "registration" ? options.registrationResolver : options.reconciliationResolver;
    const result = await resolver?.(ownerName) ?? null;
    return result === null ? null : { ...result, app };
  };
}
