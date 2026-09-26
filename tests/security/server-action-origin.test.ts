import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORIGIN_MISCONFIGURED_MESSAGE,
  ORIGIN_REFUSED_MESSAGE,
} from "@/lib/security/server-action-origin";
import { foreignOrigin, trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

// Dynamic auth imports retain this file's mocks until the graph is cleared.
afterAll(() => { vi.resetModules(); });

/**
 * Issue 700: Next's own server-action origin check compares only the Origin
 * HOST against the request's (forwarded) host, so a client that names a
 * foreign host in Host or X-Forwarded-Host runs the action under a foreign
 * Origin. The app guard below is the same trusted-origin comparison the
 * route handlers make (src/lib/security/request-origin.ts), applied inside
 * every server action.
 */

// Each case swaps this before calling the action; next/headers resolves it.
const headerState = vi.hoisted(() => ({ current: new Headers() }));

const mocks = vi.hoisted(() => {
  const signIn = vi.fn();
  const signOut = vi.fn();
  return {
    signIn,
    signOut,
    nextAuth: vi.fn(() => ({
      handlers: { GET: vi.fn(), POST: vi.fn() },
      auth: vi.fn(),
      signIn,
      signOut,
    })),
    github: vi.fn(() => ({ id: "github" })),
  };
});

vi.mock("next/headers", () => ({ headers: async () => headerState.current }));
vi.mock("next-auth", () => ({ default: mocks.nextAuth }));
vi.mock("next-auth/providers/github", () => ({ default: mocks.github }));

useTrustedOrigin();

function givenRequestHeaders(headers: Record<string, string>): void {
  headerState.current = new Headers(headers);
}

async function guard(): Promise<void> {
  const { assertTrustedServerActionOrigin } = await import("@/lib/security/server-action-origin");
  await assertTrustedServerActionOrigin();
}

describe("the server-action origin guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("resolves a request from the trusted origin", async () => {
    givenRequestHeaders({ origin: trustedOrigin, host: "overflow.internal" });

    await expect(guard()).resolves.toBeUndefined();
  });

  it("refuses a foreign origin whose Host and X-Forwarded-Host name the same foreign host", async () => {
    givenRequestHeaders({
      origin: foreignOrigin,
      host: "attacker.example",
      "x-forwarded-host": "attacker.example",
    });

    await expect(guard()).rejects.toHaveProperty("message", ORIGIN_REFUSED_MESSAGE);
  });

  it.each([
    ["a hostname with the trusted origin as a prefix", "https://overflow.example.attacker.example"],
    ["the trusted hostname over HTTP", "http://overflow.example"],
    ["the trusted hostname on another port", "https://overflow.example:8443"],
  ])("refuses %s", async (_case, origin) => {
    givenRequestHeaders({ origin, host: "overflow.internal" });

    await expect(guard()).rejects.toHaveProperty("message", ORIGIN_REFUSED_MESSAGE);
  });

  it("refuses a request carrying no origin header", async () => {
    givenRequestHeaders({ host: "overflow.internal" });

    await expect(guard()).rejects.toHaveProperty("message", ORIGIN_REFUSED_MESSAGE);
  });

  it("refuses the literal null origin", async () => {
    givenRequestHeaders({ origin: "null", host: "overflow.internal" });

    await expect(guard()).rejects.toHaveProperty("message", ORIGIN_REFUSED_MESSAGE);
  });

  it("refuses as misconfigured when APP_URL is unset even when Origin is what APP_URL would have been", async () => {
    givenRequestHeaders({ origin: trustedOrigin, host: "overflow.internal" });
    vi.stubEnv("APP_URL", undefined);

    await expect(guard()).rejects.toHaveProperty("message", ORIGIN_MISCONFIGURED_MESSAGE);
  });

  it("refuses as misconfigured when APP_URL is not a URL", async () => {
    givenRequestHeaders({ origin: trustedOrigin, host: "overflow.internal" });
    vi.stubEnv("APP_URL", "not a url");

    await expect(guard()).rejects.toHaveProperty("message", ORIGIN_MISCONFIGURED_MESSAGE);
  });

  it("resolves the production proxy shape", async () => {
    vi.stubEnv("APP_URL", "https://overflow.nitjsefni.eu");
    givenRequestHeaders({
      origin: "https://overflow.nitjsefni.eu",
      host: "overflow.nitjsefni.eu",
      "x-forwarded-host": "overflow.nitjsefni.eu",
    });

    await expect(guard()).resolves.toBeUndefined();
  });
});

/**
 * The discovery half: the test walks src/ at run time for files whose first
 * statement is the "use server" directive, imports each one, and holds every
 * exported action to the guard — a foreign origin must be refused before any
 * next-auth call. A future server-action file that forgets the guard fails
 * here; a broken discovery fails on the two known files.
 * Anything discovery cannot exercise is refused outright: every file under src/
 * with a "use server" directive line anywhere — an inline function-level action,
 * or a module whose directive follows another one such as "use strict" — must
 * also be a discovered module, so an action cannot escape the check by where
 * it declares itself.
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function typescriptFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...typescriptFilesUnder(path));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * True when the first statement — skipping whitespace and comments, which may
 * legally precede a directive — is the "use server" directive.
 */
function declaresUseServer(source: string): boolean {
  let index = 0;
  for (;;) {
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index);
      if (newline === -1) return false;
      index = newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) return false;
      index = end + 2;
      continue;
    }
    break;
  }
  return source.startsWith('"use server"', index) || source.startsWith("'use server'", index);
}

function discoverServerActionFiles(): string[] {
  return typescriptFilesUnder(join(repositoryRoot, "src"))
    .filter((path) => declaresUseServer(readFileSync(path, "utf8")))
    .map((path) => path.slice(repositoryRoot.length));
}

const USE_SERVER_LINE = /^\s*["']use server["'];?\s*$/m;

/** Every file under src/ with a "use server" directive on a line of its own. */
function filesWithUseServerLine(): string[] {
  return typescriptFilesUnder(join(repositoryRoot, "src"))
    .filter((path) => USE_SERVER_LINE.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(repositoryRoot.length));
}

describe("coverage of the guard across every server action", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("finds every \"use server\" directive in a module the guard check exercises", () => {
    const discovered = discoverServerActionFiles();
    const declaring = filesWithUseServerLine();
    expect(declaring, "found no \"use server\" line under src/").toContain("src/lib/auth/sign-out-action.ts");

    for (const file of declaring) {
      expect(
        discovered,
        `${file} declares "use server" where the origin-guard coverage check cannot exercise it; ` +
          `move the action into a guarded module whose first statement is "use server"`,
      ).toContain(file);
    }
  });

  it("refuses a foreign origin on every exported action before next-auth is reached", async () => {
    const files = discoverServerActionFiles();
    expect(files.length, "discovered no server-action files under src/").toBeGreaterThan(0);
    expect(files, "discovery lost sign-out-action.ts").toContain("src/lib/auth/sign-out-action.ts");
    expect(files, "discovery lost sign-in-actions.ts").toContain("src/lib/auth/sign-in-actions.ts");

    for (const file of files) {
      const module = (await import(pathToFileURL(join(repositoryRoot, file)).href)) as Record<string, unknown>;
      const exportedFunctions = Object.entries(module).filter(([, value]) => typeof value === "function");
      expect(exportedFunctions.length, `${file} exports no functions`).toBeGreaterThan(0);

      for (const [name] of exportedFunctions) {
        vi.resetModules();
        vi.clearAllMocks();
        const freshModule = (await import(pathToFileURL(join(repositoryRoot, file)).href)) as Record<string, unknown>;
        givenRequestHeaders({
          origin: foreignOrigin,
          host: "attacker.example",
          "x-forwarded-host": "attacker.example",
        });

        await expect(
          (freshModule[name] as () => Promise<unknown>)(),
          `${file}: export ${name} did not refuse a foreign origin`,
        ).rejects.toHaveProperty("message", ORIGIN_REFUSED_MESSAGE);
        expect(mocks.nextAuth, `${file}: export ${name} loaded @/auth`).not.toHaveBeenCalled();
        expect(mocks.signIn, `${file}: export ${name} reached next-auth`).not.toHaveBeenCalled();
        expect(mocks.signOut, `${file}: export ${name} reached next-auth`).not.toHaveBeenCalled();
      }
    }
  });
});
