/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { RedirectSignal, mocks } = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(readonly target: string) {
      super(`redirect to ${target}`);
    }
  }
  return {
    RedirectSignal,
    mocks: {
      auth: vi.fn(),
      currentRole: vi.fn(),
      signIn: vi.fn(),
      signOutAction: vi.fn(),
      redirect: vi.fn((target: string) => {
        throw new RedirectSignal(target);
      }),
    },
  };
});

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/auth", () => ({ auth: mocks.auth, signIn: mocks.signIn }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: mocks.currentRole }));
vi.mock("@/lib/auth/sign-out-action", () => ({ signOutAction: mocks.signOutAction }));

import HomePage from "@/app/page";
import SessionPage from "@/app/session/page";
import { requireMemberPageSession } from "@/lib/dashboard/session";

// Each entry is the real module that serves that path. /dashboard stands for every
// protected page: all seven delegate their gate to requireMemberPageSession and
// redirect only through it.
const routes: Record<string, (query: URLSearchParams) => Promise<unknown>> = {
  "/": () => HomePage(),
  "/dashboard": () => requireMemberPageSession(),
  "/session": (query) => SessionPage({ searchParams: Promise.resolve(Object.fromEntries(query)) }),
};

const walkCap = 8;

type Walk = {
  trace: string[];
  /** Whatever the route that stopped redirecting returned, so a caller can render it. */
  page: unknown;
};

async function walkFrom(start: string): Promise<Walk> {
  const trace: string[] = [];
  let current = start;
  for (let hop = 0; hop < walkCap; hop += 1) {
    trace.push(current);
    const [pathname, search = ""] = current.split("?");
    const route = routes[pathname];
    if (route === undefined) {
      throw new Error(`the walk reached ${current}, which no route in this test can serve: ${trace.join(" -> ")}`);
    }
    try {
      const page = await route(new URLSearchParams(search));
      return { trace, page };
    } catch (error) {
      if (!(error instanceof RedirectSignal)) {
        throw error;
      }
      current = error.target;
    }
  }
  throw new Error(`no route stopped redirecting within ${walkCap} hops: ${[...trace, current].join(" -> ")}`);
}

describe("redirect graph for a JWT the ledger cannot vouch for", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: {
        id: "00000000-0000-4000-8000-000000000004",
        name: "Stranded member",
        role: "MEMBER",
      },
    });
  });

  // The heading is the assertion that spans the two modules: the helper writes the
  // reason into the query string and the recovery page reads it back. Asserting the
  // query string instead would pin the producer to itself and let the pair drift.
  it.each([
    {
      name: "the role lookup throws",
      arrange: () => mocks.currentRole.mockRejectedValue(new Error("the ledger is unreachable")),
      heading: /ledger could not be reached/i,
    },
    {
      name: "the role lookup finds no member record",
      arrange: () => mocks.currentRole.mockResolvedValue(null),
      heading: /clear this sign-in and start again/i,
    },
  ])("settles on the matching recovery copy instead of bouncing when $name", async ({ arrange, heading }) => {
    arrange();

    const { trace, page } = await walkFrom("/");

    expect(trace[0]).toBe("/");
    expect(trace).toContain("/dashboard");
    expect(new Set(trace).size, `a target repeats, so the walk is a loop: ${trace.join(" -> ")}`).toBe(trace.length);
    expect(trace.at(-1)).not.toBe("/");

    render(page as ReactElement);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(heading);
  });
});
