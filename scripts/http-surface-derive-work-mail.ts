import { createWorkMailDeleteHandler, createWorkMailGetHandler, createWorkMailPostHandler,
  type WorkMailRouteDependencies } from "../src/app/api/account/work-mail/route.ts";
import { createWorkMailConfirmPostHandler } from "../src/app/api/account/work-mail/confirm/route.ts";
import { createWorkMailUnsubscribePostHandler } from "../src/app/api/work-mail/unsubscribe/route.ts";
import type { SqlClient } from "../src/lib/db/types.ts";
import { derivedAnswer, memberRequest, mutationRequest, withAppUrl, type DerivedAnswer } from "./http-surface-derive.ts";
import { fixtureGithubUserId, fixtureMemberId, fixtureNowMs } from "./http-surface-fixtures.ts";

const at = new Date(fixtureNowMs);

export async function workMailSurfaceAnswers(): Promise<Record<string, DerivedAnswer>> {
  // Every time is set so each subscription field records its non-null shape.
  const dependencies: WorkMailRouteDependencies = {
    getSession: async () => ({ user: { id: fixtureMemberId } }),
    getSql: () => ({}) as SqlClient,
    findIdentity: async () => ({ githubUserId: fixtureGithubUserId, githubLogin: "member" }),
    readConfig: () => ({ enabled: true, from: "work@mail.example.org", dailyLimit: 10,
      smtp: { host: "smtp.mail.example.org", port: 465, username: "sender", password: "stub" } }),
    createStore: () => ({
      requestConfirmation: async () => ({ kind: "suppressed" }),
      confirm: async () => true,
      getSubscription: async () => ({ id: fixtureMemberId, address: "member@example.org", confirmedAt: at,
        confirmExpiresAt: at, lastNotifiedAt: at, createdAt: at, updatedAt: at }),
      deleteSubscription: async () => true,
    }),
  };
  return withAppUrl(async () => ({
    "GET /api/account/work-mail": await derivedAnswer(await createWorkMailGetHandler(dependencies)()),
    "POST /api/account/work-mail": await derivedAnswer(await createWorkMailPostHandler(dependencies)(
      mutationRequest("/api/account/work-mail", "POST", { address: "member@example.org" }))),
    "DELETE /api/account/work-mail": await derivedAnswer(await createWorkMailDeleteHandler(dependencies)(
      mutationRequest("/api/account/work-mail", "DELETE"))),
    "POST /api/account/work-mail/confirm": await derivedAnswer(await createWorkMailConfirmPostHandler(dependencies)(
      mutationRequest("/api/account/work-mail/confirm", "POST", { token: "stub" }))),
    "POST /api/work-mail/unsubscribe": await derivedAnswer(await createWorkMailUnsubscribePostHandler({
      deleteSubscriptionById: async () => true, verifyToken: () => null,
    })(new Request(new URL("/api/work-mail/unsubscribe?token=stub", memberRequest("/").url), { method: "POST" }))),
  }));
}
