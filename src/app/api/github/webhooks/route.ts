import { GitHubGateway } from "@/lib/github/client";
import {
  parseGitHubWebhookDelivery,
  type GitHubWebhookDelivery,
} from "@/lib/github/webhook-schema";
import { verifyGitHubWebhookSignature } from "@/lib/github/webhook-signature";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository } from "@/lib/fold/reconcile";
import { processWebhook } from "@/lib/webhooks/processor";

export type GitHubWebhookRouteDependencies = {
  secret: string | undefined;
  processWebhook(delivery: GitHubWebhookDelivery): Promise<unknown>;
};

export function createGitHubWebhookPostHandler(dependencies: GitHubWebhookRouteDependencies) {
  return async function post(request: Request): Promise<Response> {
    const event = request.headers.get("x-github-event");
    const deliveryId = request.headers.get("x-github-delivery");
    const signature = request.headers.get("x-hub-signature-256");
    if (event === null || deliveryId === null || signature === null) {
      return new Response(null, { status: 400 });
    }
    if (dependencies.secret === undefined || dependencies.secret.length === 0) {
      return new Response(null, { status: 503 });
    }

    const rawBody = Buffer.from(await request.arrayBuffer());
    if (!verifyGitHubWebhookSignature(rawBody, signature, dependencies.secret)) {
      return new Response(null, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      return new Response(null, { status: 400 });
    }
    const delivery = parseGitHubWebhookDelivery(event, deliveryId, payload);
    if (delivery === null) {
      return new Response(null, { status: 400 });
    }

    try {
      await dependencies.processWebhook(delivery);
      return new Response(null, { status: 202 });
    } catch {
      return new Response(null, { status: 503 });
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  return createGitHubWebhookPostHandler({
    secret: process.env.GITHUB_WEBHOOK_SECRET,
    processWebhook: async (delivery) => {
      const store = new PostgresFoldStore();
      return processWebhook({
        store,
        reconcileRepository: async (repositoryId) => {
          const repository = await store.getRepository(repositoryId);
          if (repository === null) {
            throw new Error("Repository was not found.");
          }
          const accessToken = await store.getGitHubAccessToken(repository.sponsor.id);
          if (accessToken === null) {
            throw new Error("GitHub access token was not available.");
          }
          return reconcileRepository({
            store,
            github: new GitHubGateway({ accessToken }),
          }, repositoryId);
        },
      }, delivery);
    },
  })(request);
}
