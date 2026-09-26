import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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

    await expect(guard()).rejects.toThrow("The request origin is not allowed.");
  });

  it("refuses a request carrying no origin header", async () => {
    givenRequestHeaders({ host: "overflow.internal" });

    await expect(guard()).rejects.toThrow("The request origin is not allowed.");
  });

  it("refuses the literal null origin", async () => {
    givenRequestHeaders({ origin: "null", host: "overflow.internal" });

    await expect(guard()).rejects.toThrow("The request origin is not allowed.");
  });

  it("refuses when APP_URL is unset even when Origin is what APP_URL would have been", async () => {
    givenRequestHeaders({ origin: trustedOrigin, host: "overflow.internal" });
    vi.stubEnv("APP_URL", undefined);

    await expect(guard()).rejects.toThrow("The request origin is not allowed.");
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

describe("coverage of the guard across every server action", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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

      for (const [name, value] of exportedFunctions) {
        givenRequestHeaders({
          origin: foreignOrigin,
          host: "attacker.example",
          "x-forwarded-host": "attacker.example",
        });

        await expect(
          (value as () => Promise<unknown>)(),
          `${file}: export ${name} did not refuse a foreign origin`,
        ).rejects.toThrow("The request origin is not allowed.");
        expect(mocks.signIn, `${file}: export ${name} reached next-auth`).not.toHaveBeenCalled();
        expect(mocks.signOut, `${file}: export ${name} reached next-auth`).not.toHaveBeenCalled();
      }
    }
  });
});
