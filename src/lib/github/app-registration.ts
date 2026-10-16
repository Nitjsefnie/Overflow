import {
  createAppInstallationLookup,
  type AppInstallationAuthOptions,
} from "@/lib/github/app-installation-auth";

/** Registration uses its own App config, supplied by the Node wiring site. */
export function createAppRegistration(options: AppInstallationAuthOptions): {
  lookupInstallation(ownerName: string): Promise<{ installationId: number } | null>;
} {
  return { lookupInstallation: createAppInstallationLookup(options) };
}
