import { afterEach, expect, it, vi } from "vitest";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";

const { productionAuth, productionRole } = await vi.hoisted(async () => {
  // Re-warm a real graph regardless of earlier files on this nonisolated worker.
  vi.resetModules();
  await import("@/app/api/moderation/[id]/route");
  return { productionAuth: vi.fn(), productionRole: vi.fn() };
});

vi.mock("@/auth", () => ({ auth: productionAuth }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: productionRole }));

const memberSession = { user: { id: "00000000-0000-4000-8000-000000000002", role: "MEMBER" as const } };
const auditId = "00000000-0000-4000-8000-000000000004";
const requests = guardedRequests(`/api/moderation/${auditId}`);

useTrustedOrigin();
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it("rebuilds a warmed production audit handler with the registered role mock after resetting modules", async () => {
  const roleFailure = vi.spyOn(console, "error");
  vi.stubEnv("OVERFLOW_DATABASE_URL", undefined);
  productionAuth.mockResolvedValue(memberSession);
  productionRole.mockResolvedValue("MEMBER");

  // Vitest 5 keeps the cached real dependency graph despite the later vi.mock.
  // This arm pins the stale role resolver behind the 502 in issue 1214; it
  // must fail if mock registration ever starts rebuilding cached graphs.
  const { PATCH: warmedHandler } = await import("@/app/api/moderation/[id]/route");
  const poisoned = await warmedHandler(
    requests.json({ action: "dismiss", reason: "A member cannot decide an audit." }, "PATCH"),
    { params: Promise.resolve({ id: auditId }) },
  );
  expect(poisoned.status).toBe(502);
  await expect(poisoned.json()).resolves.toEqual({
    error: { code: "UPSTREAM_FAILURE", message: "Unable to authorize the moderator request." },
  });
  expect(roleFailure).toHaveBeenCalledWith(
    "Moderator route gate: role lookup failed.",
    expect.objectContaining({ message: "OVERFLOW_DATABASE_URL must be configured before using the database." }),
  );

  // Resetting must rebuild that graph with the registered mocks. Without it,
  // the member request still reaches the real role resolver and returns 502.
  vi.resetModules();
  const { PATCH: cleanHandler } = await import("@/app/api/moderation/[id]/route");
  productionAuth.mockResolvedValueOnce(null);
  const anonymous = await cleanHandler(
    requests.json({ action: "dismiss", reason: "No session may decide an audit." }, "PATCH"),
    { params: Promise.resolve({ id: auditId }) },
  );
  expect(anonymous.status).toBe(401);
  await expect(anonymous.json()).resolves.toEqual({
    error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
  });

  const member = await cleanHandler(
    requests.json({ action: "dismiss", reason: "A member cannot decide an audit." }, "PATCH"),
    { params: Promise.resolve({ id: auditId }) },
  );
  expect(member.status).toBe(403);
  await expect(member.json()).resolves.toEqual({
    error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
  });
});
