import { exportAccount, formatAccountExport, type AccountExport } from "@/lib/accounts/export";
import { findLiveAccountIdentity } from "@/lib/accounts/self-service";
import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import { rejectUntrustedRequest } from "@/lib/security/request-origin";

type Session = { user: { id: string } };
type Identity = NonNullable<Awaited<ReturnType<typeof findLiveAccountIdentity>>>;

export type AccountExportRouteDependencies = {
  getSession: () => Promise<Session | null>;
  getSql: () => SqlClient;
  findIdentity?: (sql: SqlClient, userId: string) => Promise<Identity | null>;
  exportAccount?: (sql: SqlClient, githubUserId: number) => Promise<AccountExport | null>;
};

export function createAccountExportPostHandler(dependencies: AccountExportRouteDependencies) {
  return async function postAccountExport(request: Request): Promise<Response> {
    const untrusted = rejectUntrustedRequest(request);
    if (untrusted !== null) return untrusted;

    let session: Session | null;
    try {
      session = await dependencies.getSession();
    } catch (error) {
      console.error("Account export session failed.", error);
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to export account data.");
    }
    if (session === null) return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");

    let sql: SqlClient;
    let identity: Identity | null;
    try {
      sql = dependencies.getSql();
      identity = await (dependencies.findIdentity ?? findLiveAccountIdentity)(sql, session.user.id);
    } catch (error) {
      console.error("Account export lookup failed.", error);
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to export account data.");
    }
    if (identity === null) return errorResponse(403, "FORBIDDEN", "A member account is required.");

    try {
      const document = await (dependencies.exportAccount ?? exportAccount)(sql, identity.githubUserId);
      if (document === null) return errorResponse(403, "FORBIDDEN", "A member account is required.");
      return new Response(formatAccountExport(document), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": 'attachment; filename="overflow-account-export.json"',
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      console.error("Account export operation failed.", error);
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to export account data.");
    }
  };
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export const POST = createAccountExportPostHandler({
  async getSession() {
    const { auth } = await import("@/auth");
    const session = await auth();
    const user = session?.user as { id?: unknown; role?: unknown } | undefined;
    if (typeof user?.id !== "string" || (user.role !== "MEMBER" && user.role !== "MODERATOR")) return null;
    return { user: { id: user.id } };
  },
  getSql,
});
