import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./global-setup";
import { runNeedsSharedPostgres } from "./shared-postgres-need";

/**
 * Pins the lazy-start wiring of the shared postgres globalSetup (issue 1070)
 * on the path a whole-suite run cannot see: vitest runs globalSetup only in
 * the main process and CI only runs the full suite, whose file list always
 * matches, so a regression to always-start survives every committed test
 * silently. The scan module itself has its own unit tests
 * (shared-postgres-need.test.ts); here it is mocked to pin the WIRING —
 * setup() resolves the run's specifications, passes exactly their moduleIds
 * to the scan, and when the scan says no, provides nothing at all.
 *
 * The no-match path never touches Docker: no container is started, no client
 * is created. The match path is deliberately unpinned here — pinning it would
 * need a real container in a unit test; the DB suites exercise it end to end.
 * A scan-bypass mutant (start unconditionally) fails every case below,
 * because the mutant reaches the match path and its provide-with-facts (or
 * parked-failure) call is exactly what these assertions refuse.
 */
vi.mock("./shared-postgres-need", () => ({
  SHARED_POSTGRES_MARKER: "startPostgresContainer",
  runNeedsSharedPostgres: vi.fn(),
}));

const scanMock = vi.mocked(runNeedsSharedPostgres);

interface FakeProject {
  provide: ReturnType<typeof vi.fn>;
  vitest: {
    filenamePattern?: readonly string[];
    getRelevantTestSpecifications: ReturnType<typeof vi.fn>;
  };
}

function fakeProject({ specs, filenamePattern }: {
  specs: readonly { moduleId: string }[];
  filenamePattern?: readonly string[];
}): FakeProject {
  return {
    provide: vi.fn(),
    vitest: {
      ...(filenamePattern === undefined ? {} : { filenamePattern }),
      getRelevantTestSpecifications: vi.fn().mockResolvedValue(specs),
    },
  };
}

function callSetup(project: FakeProject): Promise<void> {
  return setup(project as unknown as Parameters<typeof setup>[0]);
}

describe("the shared postgres globalSetup starts nothing for a run that needs no shared postgres", () => {
  let probeDirectory: string;

  beforeEach(async () => {
    probeDirectory = await mkdtemp(join(tmpdir(), "global-setup-pin-"));
    scanMock.mockReset();
    scanMock.mockReturnValue(false);
  });

  afterEach(async () => {
    await rm(probeDirectory, { recursive: true, force: true });
  });

  it("resolves the run's files with filenamePattern defaulting to [] and provides nothing", async () => {
    const project = fakeProject({
      specs: [{ moduleId: "/repo/tests/github/plain.test.ts" }, { moduleId: "/repo/tests/lib/other.test.ts" }],
    });

    await callSetup(project);

    // A full run carries no CLI filters: the resolution must see the empty
    // list, which resolves every file, not undefined.
    expect(project.vitest.getRelevantTestSpecifications).toHaveBeenCalledWith([]);
    // The scan receives exactly the resolved file paths, and the reader it is
    // handed reads UTF-8 contents.
    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(scanMock.mock.calls[0]?.[0]).toEqual(["/repo/tests/github/plain.test.ts", "/repo/tests/lib/other.test.ts"]);
    const readFile = scanMock.mock.calls[0]?.[1];
    const probePath = join(probeDirectory, "probe.test.ts");
    await writeFile(probePath, "readable probe contents", "utf8");
    expect(readFile?.(probePath)).toBe("readable probe contents");
    // Scan says no: no facts, no parked failure, nothing.
    expect(project.provide).not.toHaveBeenCalled();
  });

  it("passes the run's filenamePattern through to the resolution unchanged", async () => {
    const filters = ["tests/github/app-installation-auth.test.ts"];
    const project = fakeProject({ specs: [{ moduleId: "/repo/tests/github/app-installation-auth.test.ts" }], filenamePattern: filters });

    await callSetup(project);

    expect(project.vitest.getRelevantTestSpecifications).toHaveBeenCalledWith(filters);
    expect(scanMock.mock.calls[0]?.[0]).toEqual(["/repo/tests/github/app-installation-auth.test.ts"]);
    expect(project.provide).not.toHaveBeenCalled();
  });

  it("provides nothing when the resolution itself is empty", async () => {
    const project = fakeProject({ specs: [] });

    await callSetup(project);

    expect(scanMock).toHaveBeenCalledWith([], expect.any(Function));
    expect(project.provide).not.toHaveBeenCalled();
  });
});
