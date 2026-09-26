import type { RouteCredentialReference } from "@/lib/security/route-credential";

/**
 * The credential reference a privileged-action row records, as its two columns:
 * a ("session", NULL) pair behind a cookie session, a ("token", issuance id)
 * pair behind a bearer token, and (NULL, NULL) when no HTTP request stands
 * behind the write. No credential secret can reach either column, because the
 * reference type carries none — not a bearer token, not its hash, not a session
 * cookie value.
 */
export function credentialKind(credential?: RouteCredentialReference | null): string | null {
  return credential?.kind ?? null;
}

export function credentialTokenId(credential?: RouteCredentialReference | null): string | null {
  return credential?.kind === "token" ? credential.tokenId : null;
}
