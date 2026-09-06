import { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { GitHubGateway } from "@/lib/github/client";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { hashApiToken, readApiTokenCredential } from "@/lib/security/api-token";
import {
  rejectUnsupportedMediaType,
  rejectUntrustedRequest,
} from "@/lib/security/request-origin";
import { PostgresApiTokenStore, type ApiTokenAccount } from "@/lib/tokens/postgres-store";
import {
  RepositoryRegistrationError,
  registerRepository,
  type RepositoryRegistrationDependencies,
  type RepositoryRegistrationInput,
} from "@/lib/repositories/register";

const registrationSchema = z
  .object({
    repositoryUrl: z.string(),
    openingName: z.string(),
    actualName: z.string(),
    openingLabels: z.array(
      z
        .object({
          label: z.string(),
          comparisonPoints: z.number(),
          reservePoints: z.number(),
        })
        .strict(),
    ),
    actualLabels: z.array(
      z
        .object({
          label: z.string(),
          points: z.number(),
        })
        .strict(),
    ),
  })
  .strict();

export type RepositoryRouteSession = {
  user: { id: string; role: UserRole };
};

export type RepositoryRouteDependencies = {
  getSession: () => Promise<RepositoryRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<ApiTokenAccount | null>;
  createRegistrationDependencies: (
    session: RepositoryRouteSession,
  ) => Promise<RepositoryRegistrationDependencies>;
};

export function createRepositoryPostHandler(dependencies: RepositoryRouteDependencies) {
  return async function postRepository(request: Request): Promise<Response> {
    // Reading the credential is only a header parse, and it decides which guard
    // this request gets. A cookie-authenticated request is one the browser
    // authenticates on the client's behalf from whatever page asked, so it is
    // same-origin only. A bearer credential is attached deliberately and never
    // rides along on a cross-site request, so its origin is not consulted — but
    // both paths must be JSON, and both are refused before the token is hashed,
    // the session is read, or the body is parsed.
    const credential = readApiTokenCredential(request);
    const refusal =
      credential === null ? rejectUntrustedRequest(request) : rejectUnsupportedMediaType(request);
    if (refusal !== null) {
      return refusal;
    }

    let session: RepositoryRouteSession | null;
    try {
      if (credential !== null) {
        const hash = hashApiToken(credential);
        if (hash === null) {
          return errorResponse(401, "UNAUTHENTICATED", "The supplied API token was not accepted.");
        }
        const account = await dependencies.findAccountByTokenHash(hash);
        if (account === null) {
          return errorResponse(401, "UNAUTHENTICATED", "The supplied API token was not accepted.");
        }
        session = { user: { id: account.id, role: account.role } };
      } else {
        session = await dependencies.getSession();
      }
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to initialize repository registration.");
    }
    if (session === null) {
      return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    }

    const input = await parseInput(request);
    if (input === null) {
      return errorResponse(400, "INVALID_REQUEST", "Invalid repository registration request.");
    }

    try {
      const registrationDependencies = await dependencies.createRegistrationDependencies(session);
      const { initialImportScheduled, claimPath, ...repository } = await registerRepository(
        registrationDependencies,
        input,
      );
      return Response.json({ repository, initialImportScheduled, claimPath }, { status: 201 });
    } catch (error) {
      if (error instanceof RepositoryRegistrationError) {
        return registrationErrorResponse(error);
      }

      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to initialize repository registration.");
    }
  };
}

export const POST = createRepositoryPostHandler({
  async findAccountByTokenHash(hash) {
    return new PostgresApiTokenStore().findAccountByTokenHash(hash);
  },
  async getSession() {
    const { auth } = await import("@/auth");
    const session = await auth();
    const user = session?.user as { id?: unknown; role?: unknown } | undefined;
    if (
      typeof user?.id !== "string" ||
      (user.role !== "MEMBER" && user.role !== "MODERATOR")
    ) {
      return null;
    }
    return { user: { id: user.id, role: user.role } };
  },
  async createRegistrationDependencies(session) {
    const store = new PostgresRepositoryStore();
    const accessToken = await store.getGitHubAccessToken(session.user.id);
    const enforcementState = await store.getEnforcementState(session.user.id);
    if (accessToken === null) {
      throw new Error("GitHub access token was unavailable.");
    }
    if (enforcementState === null) {
      throw new Error("Account enforcement state was unavailable.");
    }

    return {
      actor: { ...session.user, enforcementState },
      github: new GitHubGateway({ accessToken }),
      store,
      webhook: requiredWebhookConfiguration(),
      // Existing issues predate the webhook this registration creates, so only a
      // reconciliation can bring them in. See scheduleInitialImport in register.ts.
      scheduleInitialImport(repositoryId) {
        return new PostgresFoldStore().enqueueReconciliationJob(repositoryId, "REGISTRATION");
      },
    };
  },
});

async function parseInput(request: Request): Promise<RepositoryRegistrationInput | null> {
  try {
    const result = registrationSchema.safeParse(await request.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function requiredWebhookConfiguration(): { callbackUrl: string; secret: string } {
  const callbackUrl = process.env.GITHUB_WEBHOOK_URL;
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (
    callbackUrl === undefined ||
    callbackUrl.length === 0 ||
    secret === undefined ||
    secret.length === 0
  ) {
    throw new Error("GitHub webhook configuration must be set.");
  }

  return { callbackUrl, secret };
}

function registrationErrorResponse(error: RepositoryRegistrationError): Response {
  switch (error.code) {
    case "INVALID_INPUT":
      return errorResponse(400, error.code, error.message);
    case "FORBIDDEN":
    case "GITHUB_ACCESS":
      return errorResponse(403, error.code, error.message);
    case "GITHUB_RATE_LIMITED":
      return errorResponse(429, error.code, error.message);
    case "CONFLICT":
      return errorResponse(409, error.code, error.message);
    case "UPSTREAM_FAILURE":
      return errorResponse(502, error.code, error.message);
  }
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
