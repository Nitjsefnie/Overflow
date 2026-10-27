import { errorResponse } from "@/lib/http/error-response";
import { findLiveAccountIdentity } from "@/lib/accounts/self-service";
import { readContributorMailConfig, type ContributorMailConfig } from "@/lib/accounts/work-mail-config";
import { PostgresWorkMailStore } from "@/lib/accounts/work-mail-store";
import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { rejectUntrustedRequest } from "@/lib/security/request-origin";

/** The body is one JSON object carrying one 43-character token. */
const CONFIRM_BODY_LIMIT_BYTES = 4 * 1024; // 4 KiB

type Session = { user: { id: string } };
type Identity = NonNullable<Awaited<ReturnType<typeof findLiveAccountIdentity>>>;

export type WorkMailConfirmRouteDependencies = {
  getSession: () => Promise<Session | null>;
  getSql: () => SqlClient;
  findIdentity?: (sql: SqlClient, userId: string) => Promise<Identity | null>;
  createStore?: (sql: SqlClient) => Pick<PostgresWorkMailStore, "confirm">;
  readConfig?: () => ContributorMailConfig;
};

export function createWorkMailConfirmPostHandler(dependencies: WorkMailConfirmRouteDependencies) {
  return async function confirmWorkMail(request: Request): Promise<Response> {
    if (!(dependencies.readConfig ?? readContributorMailConfig)().enabled) {
      return errorResponse(404, "NOT_FOUND", "Work mail is not enabled on this instance.");
    }
    const untrusted = rejectUntrustedRequest(request);
    if (untrusted !== null) return untrusted;

    let session: Session | null;
    let sql: SqlClient;
    let identity: Identity | null;
    try {
      session = await dependencies.getSession();
      if (session === null) return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
      sql = dependencies.getSql();
      identity = await (dependencies.findIdentity ?? findLiveAccountIdentity)(sql, session.user.id);
    } catch {
      console.error("Work mail account lookup failed.");
      return upstreamFailure();
    }
    if (identity === null) return errorResponse(403, "FORBIDDEN", "A member account is required.");

    let token: unknown = null;
    try {
      const rawBody = await readBodyWithinLimit(request, CONFIRM_BODY_LIMIT_BYTES);
      if (rawBody !== null) token = (JSON.parse(rawBody.toString("utf8")) as { token?: unknown } | null)?.token;
    } catch {}
    try {
      const store = (dependencies.createStore ?? ((client: SqlClient) => new PostgresWorkMailStore(client)))(sql);
      // Every failure answers alike, so the answer says nothing about which part of a link was wrong.
      if (typeof token !== "string" || !(await store.confirm(session.user.id, token))) {
        return errorResponse(400, "INVALID_CONFIRMATION", "The confirmation link is invalid or has expired.");
      }
    } catch {
      console.error("Work mail confirmation failed.");
      return upstreamFailure();
    }
    return Response.json({ confirmed: true });
  };
}

function upstreamFailure(): Response {
  return errorResponse(502, "UPSTREAM_FAILURE", "The work mail operation could not complete.");
}

export const POST = createWorkMailConfirmPostHandler({
  async getSession() {
    const { auth } = await import("@/auth");
    const session = await auth();
    const user = session?.user as { id?: unknown; role?: unknown } | undefined;
    if (typeof user?.id !== "string" || (user.role !== "MEMBER" && user.role !== "MODERATOR")) return null;
    return { user: { id: user.id } };
  },
  getSql,
});
