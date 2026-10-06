import { afterAll, describe, expect, it, vi } from "vitest";
import { createAccountDeleteHandler } from "@/app/api/account/route";
import type { AccountDeletionOutcome } from "@/lib/accounts/deletion";
import type { SqlClient } from "@/lib/db/types";
import type { ToolDefinition } from "@/lib/mcp/protocol";
import {
  createForgeIdentitiesDeleteHandler,
  createForgeIdentitiesPostHandler,
} from "@/app/api/forge-identities/route";
import { createMcpPostHandler, type McpRouteDependencies } from "@/app/api/mcp/route";
import {
  createModerationAuditPatchHandler,
  type ModerationAuditRouteContext,
} from "@/app/api/moderation/[id]/route";
import {
  createModerationClosePatchHandler,
  createModerationPostHandler,
} from "@/app/api/moderation/route";
import { createModerationReversalPostHandler } from "@/app/api/moderation/adjustments/reversal/route";
import { createModeratorPostHandler } from "@/app/api/moderation/moderators/route";
import { createModerationAdjustmentPostHandler } from "@/app/api/moderation/recalibration/adjustment/route";
import { createRederivationPostHandler } from "@/app/api/moderation/rederivation/route";
import { createSettlementOverridePatchHandler } from "@/app/api/overrides/[id]/route";
import { createSettlementOverridePostHandler } from "@/app/api/overrides/route";
import {
  createRepositoryDeleteHandler,
  createRepositoryPostHandler,
  type RepositoryRouteDependencies,
} from "@/app/api/repositories/route";
import { requestHost, trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

// Bind the page/route graph to this file's mocks and release it afterward.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

useTrustedOrigin();

/**
 * The per-route body limits issue 661 wires every authenticated JSON route's
 * body read through `readBodyWithinLimit` with. These are the route files' own
 * constants restated: a drift between a route constant and the value here is
 * exactly what the over-limit and exact-limit tests catch.
 *
 * The 8 KiB value is a deliberate raise from the plan's 4 KiB: the audit and
 * decision schemas carry `reasonText()`, whose 2000-character cap admits ~6 KB
 * UTF-8 bodies (2000 three-byte characters), so 4 KiB would refuse legitimate
 * max-length reasons before the schema could judge them.
 */
const ACCOUNT_DELETE_LIMIT_BYTES = 4 * 1024; // 4 KiB
const AUDIT_DECISION_LIMIT_BYTES = 8 * 1024; // 8 KiB
const MODERATION_LIMIT_BYTES = 32 * 1024; // 32 KiB
const REPOSITORIES_LIMIT_BYTES = 128 * 1024; // 128 KiB
const MCP_LIMIT_BYTES = 1024 * 1024; // 1 MiB

const moderatorId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const auditId = "00000000-0000-4000-8000-000000000003";
const requestId = "00000000-0000-4000-8000-000000000004";

const auditContext: ModerationAuditRouteContext = { params: Promise.resolve({ id: auditId }) };
const decisionContext = { params: Promise.resolve({ id: requestId }) };

/**
 * A JSON request body of exactly `totalBytes` bytes: the pad fills the gap
 * between the fixed envelope and the target. Pad characters are ASCII, so the
 * string's length is its UTF-8 byte length and the Content-Length undici
 * declares for it matches exactly.
 */
function paddedBody(prefix: string, suffix: string, totalBytes: number): string {
  const padBytes = totalBytes - prefix.length - suffix.length;
  expect(padBytes, `envelope alone exceeds ${totalBytes} bytes`).toBeGreaterThanOrEqual(0);
  return `${prefix}${"x".repeat(padBytes)}${suffix}`;
}

/** The 413 envelope every wired route answers an over-limit body with. */
async function expectPayloadTooLarge(response: Response): Promise<void> {
  expect(response.status).toBe(413);
  await expect(response.json()).resolves.toEqual({
    error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." },
  });
}

/** A JSON request carrying a raw body string from the trusted origin. */
function jsonRequest(path: string, body: string, method = "POST"): Request {
  return new Request(new URL(path, requestHost).toString(), {
    method,
    headers: { origin: trustedOrigin, "content-type": "application/json" },
    body,
  });
}

/**
 * Reads are tracked on the stream itself with highWaterMark 0: pull runs only
 * when the consumer actually reads, so handedOutBytes counts bytes the handler
 * delivered and never a queue refill it never asked for. Emits one chunk per
 * pull without end; once the bytes handed out reach the hang threshold —
 * comfortably past the limit — pull returns a promise that never resolves, so
 * a handler that drains instead of cancelling hangs the test rather than
 * passing it.
 */
function neverEndingStream(chunkByteLength: number): {
  stream: ReadableStream<Uint8Array>;
  record: { handedOutBytes: number; cancelled: boolean };
} {
  const HANG_AFTER_BYTES = chunkByteLength * 6;
  let handedOutBytes = 0;
  const record = { handedOutBytes: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(chunkByteLength));
        handedOutBytes += chunkByteLength;
        record.handedOutBytes = handedOutBytes;
        if (handedOutBytes >= HANG_AFTER_BYTES) {
          return new Promise(() => {});
        }
      },
      cancel() {
        record.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, record };
}

/** A streaming POST from the trusted origin; undici declares no Content-Length. */
function streamRequest(path: string, stream: ReadableStream<Uint8Array>): Request {
  return new Request(new URL(path, requestHost).toString(), {
    method: "POST",
    headers: { origin: trustedOrigin, "content-type": "application/json" },
    body: stream,
    // A Request with a stream body requires declaring the duplex direction.
    duplex: "half",
  } as RequestInit);
}

// ---------------------------------------------------------------------------
// Per-route dependency stubs. Every 413 must land before the route's own work,
// so each builder arms the downstream dependency to fail the test loudly if
// the over-limit body reaches it.
// ---------------------------------------------------------------------------

const now = Date.parse("2026-09-26T12:00:00Z");
const deletedOutcome: AccountDeletionOutcome = {
  kind: "DELETED",
  githubUserId: 42,
  accountId: "internal-id",
  alreadyDeleted: false,
  deletedAt: "2026-09-26T12:00:00Z",
  removedApiTokens: 0,
  scrubbedForgeIdentities: 0,
  leftNoLiveModerator: false,
};

function accountDependencies() {
  return {
    getSession: vi.fn(async () => ({ user: { id: "internal-id", authenticatedAt: now / 1000 } })),
    getSql: vi.fn(() => ({}) as SqlClient),
    findIdentity: vi.fn(async () => ({ githubUserId: 42, githubLogin: "Alice" })),
    deleteAccount: vi.fn(async () => deletedOutcome),
    endSession: vi.fn(async () => undefined),
    now: () => now,
  };
}

function forgeDependencies() {
  return {
    getSession: vi.fn(async () => ({ user: { id: "user-1", role: "MEMBER" as const } })),
    getCurrentRole: vi.fn(async () => "MEMBER" as const),
    createIdentityStore: vi.fn(() => {
      throw new Error("the identity store must not be reached for an over-limit body");
    }),
    // No tokenEncryptionKey: the link path answers 503 CONFIGURATION if an
    // over-limit body is not refused first, so the RED answer is not a 413.
  };
}

function moderatorDependencies() {
  return {
    getSession: vi.fn(async () => ({ user: { id: moderatorId, role: "MODERATOR" as const } })),
    findAccountByTokenHash: vi.fn(async () => null),
    getCurrentRole: vi.fn(async () => "MODERATOR" as const),
    createService: vi.fn(async () => {
      throw new Error("the moderation service must not be reached for an over-limit body");
    }),
  };
}

function memberOverrideDependencies() {
  return {
    getSession: vi.fn(async () => ({ user: { id: memberId, role: "MEMBER" as const } })),
    findAccountByTokenHash: vi.fn(async () => null),
    getCurrentRole: vi.fn(async () => "MEMBER" as const),
    createService: vi.fn(async () => {
      throw new Error("the override service must not be reached for an over-limit body");
    }),
  };
}

function mcpDependencies(): McpRouteDependencies {
  return {
    getSession: vi.fn(async () => ({ user: { id: memberId } })),
    findAccountByTokenHash: vi.fn(async () => null),
    getCurrentRole: vi.fn(async () => "MEMBER" as const),
    defineTools: vi.fn((): ToolDefinition[] => {
      throw new Error("the tool registry must not be built for an over-limit body");
    }),
  };
}

function repositoryDependencies(): RepositoryRouteDependencies {
  return {
    getSession: vi.fn(async () => ({ user: { id: memberId, role: "MEMBER" as const } })),
    findAccountByTokenHash: vi.fn(async () => null),
    getCurrentRole: vi.fn(async () => "MEMBER" as const),
    createRegistrationDependencies: vi.fn(async () => {
      throw new Error("registration wiring must not be built for an over-limit body");
    }),
  };
}

// ---------------------------------------------------------------------------
// Over-limit bodies answer 413 in the route's own error envelope, before any
// downstream dependency runs. Bodies built as strings carry an exact
// Content-Length, so these exercise the reader's declared-size arm; the
// never-ending stream tests below exercise the streaming arm.
// ---------------------------------------------------------------------------

describe("over-limit request bodies are refused with 413", () => {
  it("DELETE /api/account refuses a body past 4 KiB before the account lookup", async () => {
    const deps = accountDependencies();
    const response = await createAccountDeleteHandler(deps)(
      jsonRequest(
        "/api/account",
        paddedBody(`{"confirmLogin":"`, `"}`, ACCOUNT_DELETE_LIMIT_BYTES + 1),
        "DELETE",
      ),
    );
    await expectPayloadTooLarge(response);
    expect(deps.findIdentity).not.toHaveBeenCalled();
    expect(deps.deleteAccount).not.toHaveBeenCalled();
  });

  it("POST /api/forge-identities refuses a body past 4 KiB before the identity store", async () => {
    const deps = forgeDependencies();
    const response = await createForgeIdentitiesPostHandler(deps)(
      jsonRequest(
        "/api/forge-identities",
        paddedBody(`{"instanceUrl":"https://gitlab.example","token":`, `}`, ACCOUNT_DELETE_LIMIT_BYTES + 1),
      ),
    );
    await expectPayloadTooLarge(response);
    expect(deps.createIdentityStore).not.toHaveBeenCalled();
  });

  it("DELETE /api/forge-identities refuses a body past 4 KiB before the identity store", async () => {
    const deps = forgeDependencies();
    const response = await createForgeIdentitiesDeleteHandler(deps)(
      jsonRequest(
        "/api/forge-identities",
        paddedBody(`{"id":`, `}`, ACCOUNT_DELETE_LIMIT_BYTES + 1),
        "DELETE",
      ),
    );
    await expectPayloadTooLarge(response);
    expect(deps.createIdentityStore).not.toHaveBeenCalled();
  });

  it("PATCH /api/moderation/[id] refuses a body past 8 KiB before the service", async () => {
    const deps = moderatorDependencies();
    const response = await createModerationAuditPatchHandler(deps)(
      jsonRequest(
        `/api/moderation/${auditId}`,
        paddedBody(`{"action":"dismiss","reason":"`, `"}`, AUDIT_DECISION_LIMIT_BYTES + 1),
        "PATCH",
      ),
      auditContext,
    );
    await expectPayloadTooLarge(response);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("PATCH /api/overrides/[id] refuses a body past 8 KiB before the service", async () => {
    const deps = moderatorDependencies();
    const response = await createSettlementOverridePatchHandler(deps)(
      jsonRequest(
        `/api/overrides/${requestId}`,
        paddedBody(
          `{"action":"grant","settledPoints":1,"reason":"`,
          `"}`,
          AUDIT_DECISION_LIMIT_BYTES + 1,
        ),
        "PATCH",
      ),
      decisionContext,
    );
    await expectPayloadTooLarge(response);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("POST /api/moderation refuses a body past 32 KiB before the service", async () => {
    const deps = moderatorDependencies();
    const response = await createModerationPostHandler(deps)(
      jsonRequest("/api/moderation", paddedBody(`{"reason":"`, `"}`, MODERATION_LIMIT_BYTES + 1)),
    );
    await expectPayloadTooLarge(response);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("PATCH /api/moderation refuses a body past 32 KiB before the service", async () => {
    const deps = moderatorDependencies();
    const response = await createModerationClosePatchHandler(deps)(
      jsonRequest(
        "/api/moderation",
        paddedBody(`{"plan":"`, `"}`, MODERATION_LIMIT_BYTES + 1),
        "PATCH",
      ),
    );
    await expectPayloadTooLarge(response);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("POST /api/moderation/adjustments/reversal refuses a body past 32 KiB", async () => {
    const deps = moderatorDependencies();
    const response = await createModerationReversalPostHandler(deps)(
      jsonRequest(
        "/api/moderation/adjustments/reversal",
        paddedBody(`{"adjustmentId":"`, `"}`, MODERATION_LIMIT_BYTES + 1),
      ),
    );
    await expectPayloadTooLarge(response);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("POST /api/moderation/moderators refuses a body past 32 KiB", async () => {
    const deps = moderatorDependencies();
    const response = await createModeratorPostHandler(deps)(
      jsonRequest(
        "/api/moderation/moderators",
        paddedBody(`{"targetAccountId":"`, `"}`, MODERATION_LIMIT_BYTES + 1),
      ),
    );
    await expectPayloadTooLarge(response);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("POST /api/moderation/recalibration/adjustment refuses a body past 32 KiB", async () => {
    const deps = moderatorDependencies();
    const response = await createModerationAdjustmentPostHandler(deps)(
      jsonRequest(
        "/api/moderation/recalibration/adjustment",
        paddedBody(`{"targetAccountId":"`, `"}`, MODERATION_LIMIT_BYTES + 1),
      ),
    );
    await expectPayloadTooLarge(response);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("POST /api/moderation/rederivation refuses a body past 32 KiB", async () => {
    const deps = moderatorDependencies();
    const response = await createRederivationPostHandler(deps)(
      jsonRequest(
        "/api/moderation/rederivation",
        paddedBody(`{"repositoryId":"`, `"}`, MODERATION_LIMIT_BYTES + 1),
      ),
    );
    await expectPayloadTooLarge(response);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("POST /api/overrides refuses a body past 32 KiB before the service", async () => {
    const deps = memberOverrideDependencies();
    const response = await createSettlementOverridePostHandler(deps)(
      jsonRequest("/api/overrides", paddedBody(`{"settlementId":"`, `"}`, MODERATION_LIMIT_BYTES + 1)),
    );
    await expectPayloadTooLarge(response);
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("POST /api/repositories refuses a body past 128 KiB before the registration wiring", async () => {
    const deps = repositoryDependencies();
    const response = await createRepositoryPostHandler(deps)(
      jsonRequest(
        "/api/repositories",
        paddedBody(`{"reason":`, `}`, REPOSITORIES_LIMIT_BYTES + 1),
      ),
    );
    await expectPayloadTooLarge(response);
    expect(deps.createRegistrationDependencies).not.toHaveBeenCalled();
  });

  // The unregistration body shares the registration's limit through its own
  // reader: parseUnregisterInput bounds the DELETE read with the same
  // REPOSITORIES_BODY_LIMIT_BYTES. Pinned separately because the POST case
  // never executes it — unwiring parseUnregisterInput left this suite green
  // until this case existed (issue 661 review).
  it("DELETE /api/repositories refuses a body past 128 KiB before the registration wiring", async () => {
    const deps = repositoryDependencies();
    const response = await createRepositoryDeleteHandler(deps)(
      jsonRequest(
        "/api/repositories",
        paddedBody(`{"repositoryUrl":`, `}`, REPOSITORIES_LIMIT_BYTES + 1),
        "DELETE",
      ),
    );
    await expectPayloadTooLarge(response);
    expect(deps.createRegistrationDependencies).not.toHaveBeenCalled();
  });
});

/**
 * The 8 KiB audit/decision limit exists because `reasonText()` caps reasons at
 * 2000 characters, which is ~6 KB of UTF-8 in the densest legitimate case —
 * a body between the plan's original 4 KiB and the raised 8 KiB must pass the
 * size gate and be judged by the schema instead (a 422 here, since the reason
 * also breaks the character cap).
 */
describe("the raised 8 KiB limit carries the reason-bearing schemas", () => {
  it("PATCH /api/moderation/[id] reads a 5 KB body and lets the schema reject it", async () => {
    const deps = moderatorDependencies();
    const response = await createModerationAuditPatchHandler(deps)(
      jsonRequest(
        `/api/moderation/${auditId}`,
        paddedBody(`{"action":"dismiss","reason":"`, `"}`, 5000),
        "PATCH",
      ),
      auditContext,
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid moderation request." },
    });
    expect(deps.createService).not.toHaveBeenCalled();
  });
});

/**
 * A streamed body that crosses the limit and then never ends must be refused
 * without the handler waiting for the stream: the reader cancels the source
 * having pulled at most the limit plus one chunk. These pin the streaming arm
 * on the two largest limits (no Content-Length is declared, so the
 * declared-size pre-check cannot answer first).
 */
describe("never-ending streamed bodies are cancelled, not drained", () => {
  it("POST /api/mcp cancels a never-ending body past 1 MiB", async () => {
    const CHUNK_BYTES = 256 * 1024;
    const deps = mcpDependencies();
    const { stream, record } = neverEndingStream(CHUNK_BYTES);
    const response = await createMcpPostHandler(deps)(streamRequest("/api/mcp", stream));
    await expectPayloadTooLarge(response);
    expect(record.cancelled).toBe(true);
    expect(record.handedOutBytes).toBeLessThanOrEqual(MCP_LIMIT_BYTES + CHUNK_BYTES);
  }, 20_000);

  it("POST /api/repositories cancels a never-ending body past 128 KiB", async () => {
    const CHUNK_BYTES = 32 * 1024;
    const deps = repositoryDependencies();
    const { stream, record } = neverEndingStream(CHUNK_BYTES);
    const response = await createRepositoryPostHandler(deps)(
      streamRequest("/api/repositories", stream),
    );
    await expectPayloadTooLarge(response);
    expect(record.cancelled).toBe(true);
    expect(record.handedOutBytes).toBeLessThanOrEqual(REPOSITORIES_LIMIT_BYTES + CHUNK_BYTES);
  }, 20_000);
});

/**
 * The limit is strict-greater: a body of exactly the limit is read and parsed,
 * answering whatever the route's next gate answers for the padded payload —
 * never the 413.
 */
describe("a body at exactly the limit is read, not refused", () => {
  it("DELETE /api/account reads a 4 KiB confirmation and judges it", async () => {
    const deps = accountDependencies();
    const response = await createAccountDeleteHandler(deps)(
      jsonRequest(
        "/api/account",
        paddedBody(`{"confirmLogin":"`, `"}`, ACCOUNT_DELETE_LIMIT_BYTES),
        "DELETE",
      ),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "CONFIRMATION_MISMATCH", message: "The confirmation login does not match your account." },
    });
    expect(deps.deleteAccount).not.toHaveBeenCalled();
  });

  it("POST /api/moderation reads a 32 KiB body and lets the schema reject it", async () => {
    const deps = moderatorDependencies();
    const response = await createModerationPostHandler(deps)(
      jsonRequest("/api/moderation", paddedBody(`{"reason":"`, `"}`, MODERATION_LIMIT_BYTES)),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid moderation request." },
    });
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("POST /api/repositories reads a 128 KiB body and lets the schema reject it", async () => {
    const deps = repositoryDependencies();
    const response = await createRepositoryPostHandler(deps)(
      jsonRequest(
        "/api/repositories",
        paddedBody(`{"repositoryUrl":"`, `","provider":"bogus"}`, REPOSITORIES_LIMIT_BYTES),
      ),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid repository registration request." },
    });
    expect(deps.createRegistrationDependencies).not.toHaveBeenCalled();
  });

  it("POST /api/mcp reads a 1 MiB body and dispatches it", async () => {
    const deps = mcpDependencies();
    const defineTools = vi.fn((): ToolDefinition[] => []);
    const response = await createMcpPostHandler({ ...deps, defineTools })(
      jsonRequest("/api/mcp", paddedBody(`{`, `}`, MCP_LIMIT_BYTES)),
    );
    // The oversized-but-accepted body reaches the JSON-RPC dispatcher, which
    // answers the unparsable payload in band at HTTP 200.
    expect(defineTools).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });
});
