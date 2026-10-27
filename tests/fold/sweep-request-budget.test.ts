import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import { GitHubGraphqlClient } from "@/lib/github/graphql";
import { isTransientGitHubRequestError } from "@/lib/github/errors";
import { GitLabGateway } from "@/lib/gitlab/client";
import { checkSweepRequestBudget, readSweepRequestBudget, readSweepWindowMs, SweepBudgetSpent, withSweepRequestBudget } from "@/lib/fold/sweep-request-budget";

afterEach(() => vi.restoreAllMocks());

describe("sweep HTTP admission", () => {
  it.each([undefined, "", "0", "-1", "1.5", "oops", "Infinity"])("defaults invalid budget %s", (value) => {
    expect(readSweepRequestBudget({ RECONCILIATION_SWEEP_REQUEST_BUDGET: value })).toBe(3000);
  });
  it("accepts a positive integer override", () => {
    expect(readSweepRequestBudget({ RECONCILIATION_SWEEP_REQUEST_BUDGET: "17" })).toBe(17);
  });
  it.each([undefined, "", "0", "-1", "1.5", "oops", "Infinity", "150119987580", String(Number.MAX_SAFE_INTEGER + 1)])(
    "defaults invalid window %s to six hours", (value) => {
      expect(readSweepWindowMs({ OVERFLOW_RECONCILIATION_SWEEP_WINDOW_MINUTES: value })).toBe(6 * 60 * 60_000);
    },
  );
  it("reads the window in whole minutes, the prefixed name over the bare one", () => {
    expect(readSweepWindowMs({ OVERFLOW_RECONCILIATION_SWEEP_WINDOW_MINUTES: "90" })).toBe(90 * 60_000);
    expect(readSweepWindowMs({ RECONCILIATION_SWEEP_WINDOW_MINUTES: "45" })).toBe(45 * 60_000);
    expect(readSweepWindowMs({ OVERFLOW_RECONCILIATION_SWEEP_WINDOW_MINUTES: "90", RECONCILIATION_SWEEP_WINDOW_MINUTES: "45" }))
      .toBe(90 * 60_000);
    // The largest minute count whose product is still a safe integer.
    expect(readSweepWindowMs({ OVERFLOW_RECONCILIATION_SWEEP_WINDOW_MINUTES: "150119987579" })).toBe(150119987579 * 60_000);
  });
  it("counts REST and GraphQL in one counter, before sending, without retrying a hold", async () => {
    let spent = 0;
    let sent = 0;
    const resetAt = new Date("2030-01-01T06:00:00Z");
    const request = async () => { sent++; return Response.json({ data: { value: 7 } }); };
    const rest = new GitHubGateway({ accessToken: randomBytes(24).toString("hex"), fetch: request });
    const graphql = new GitHubGraphqlClient({ accessToken: randomBytes(24).toString("hex"), fetch: request });
    const spend = async () => ++spent <= 2 ? null : resetAt;
    await withSweepRequestBudget(spend, async () => {
      await rest.request("/repositories/1");
      expect(await graphql.query("query { value }", {})).toEqual({ value: 7 });
      let failure: unknown;
      try { await rest.request("/repositories/2"); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(SweepBudgetSpent);
      expect(isTransientGitHubRequestError(failure)).toBe(false);
      await expect(graphql.query("query { value }", {})).rejects.toBeInstanceOf(SweepBudgetSpent);
    });
    expect(sent).toBe(2);
    expect(spent).toBe(3); // The shared latch rejects siblings without another spend.
    await rest.request("/repositories/3");
    expect(sent).toBe(3); // Ordinary route and CLI reads have no budget wiring.
  });
  it("charges a GitLab read before it sends, holds without sending when spent", async () => {
    let spent = 0;
    let sent = 0;
    const resetAt = new Date("2030-01-01T06:00:00Z");
    const gateway = new GitLabGateway({
      instanceUrl: "https://gitlab.example.com",
      token: randomBytes(24).toString("hex"),
      fetch: async () => {
        sent++;
        return Response.json({
          id: 5001,
          name: "example",
          path: "example",
          path_with_namespace: "octo/example",
          visibility: "public",
          web_url: "https://gitlab.example.com/octo/example",
          namespace: { id: 1, name: "Octo", path: "octo", kind: "group" },
        });
      },
    });
    await withSweepRequestBudget(async () => ++spent <= 1 ? null : resetAt, async () => {
      await gateway.getRepository({ owner: "octo", name: "example" });
      let failure: unknown;
      try { await gateway.getRepository({ owner: "octo", name: "other" }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(SweepBudgetSpent);
      let heldAgain: unknown;
      try { await gateway.getRepository({ owner: "octo", name: "third" }); } catch (error) { heldAgain = error; }
      expect(heldAgain).toBe(failure); // The latched hold rejects siblings without another spend.
    });
    expect(sent).toBe(1); // The spent read was refused before its request went out.
    expect(spent).toBe(2);
    await gateway.getRepository({ owner: "octo", name: "example" });
    expect(sent).toBe(2); // Ordinary route and CLI reads have no budget wiring.
  });
  it("sends an already-admitted sibling even if another request latches exhaustion", async () => {
    let release!: (reset: Date | null) => void;
    let attempts = 0;
    let sent = 0;
    const firstAdmission = new Promise<Date | null>((resolve) => { release = resolve; });
    const rest = new GitHubGateway({ accessToken: randomBytes(24).toString("hex"), fetch: async () => { sent++; return Response.json({}); } });
    await withSweepRequestBudget(async () => ++attempts === 1 ? firstAdmission : new Date("2030-01-01T06:00:00Z"), async () => {
      const admitted = rest.request("/repositories/1");
      await expect(rest.request("/repositories/2")).rejects.toBeInstanceOf(SweepBudgetSpent);
      release(null);
      await admitted;
    });
    expect(sent).toBe(1);
  });

  it("charges an App installation lookup, blocking before a request when spent", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { createAppInstallationLookup } = await import("@/lib/github/app-installation-auth");
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let sent = 0;
    const lookup = createAppInstallationLookup({ config: { appId: "1", privateKey }, fetch: async () => {
      sent++; return Response.json({ id: 7 });
    } });
    // Spent before the lookup's first request: its own charge refuses the call
    // and nothing is sent.
    await expect(withSweepRequestBudget(async () => new Date("2030-01-01T06:00:00Z"),
      () => lookup("owner/repository"))).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(sent).toBe(0);
  });

  it("admits reads and logs once when the observer breaks", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await withSweepRequestBudget(async () => { throw new Error("store unavailable"); }, async () => {
      await checkSweepRequestBudget();
      await checkSweepRequestBudget();
    });
    await withSweepRequestBudget(async () => { throw new Error("store still unavailable"); }, checkSweepRequestBudget);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
