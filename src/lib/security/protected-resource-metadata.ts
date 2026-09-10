import { readTrustedOrigin } from "@/lib/security/request-origin";

/**
 * The protected-resource metadata document RFC 9728 defines: the one answer an
 * MCP client's unauthenticated discovery step can read without a credential or
 * a trusted origin. `resource` names this deployment's MCP endpoint; only the
 * header-bearer method is supported, because the cookie path is same-origin
 * only and a discovery client has neither.
 */
export function protectedResourceMetadata(): ProtectedResourceMetadata | null {
  const origin = readTrustedOrigin();
  if (origin === null) {
    return null;
  }

  return {
    resource: `${origin}/api/mcp`,
    bearer_methods_supported: ["header"],
  };
}

export type ProtectedResourceMetadata = {
  resource: string;
  bearer_methods_supported: ["header"];
};
