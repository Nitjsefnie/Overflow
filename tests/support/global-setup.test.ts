import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./global-setup";
import { runNeedsSharedPostgres } from "./shared-postgres-need";
import { createOwnedTempDirectoryRegistry } from "./owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "global-setup-pin-")]);

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
    probeDirectory = await tempDirectories.createAsync(join(tmpdir(), "global-setup-pin-"));
    scanMock.mockReset();
    scanMock.mockReturnValue(false);
  });

  afterEach(async () => {
    await tempDirectories.disposeAsync(probeDirectory);
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

  it("does not throw during setup for a mocked helper with deep valid syntax", async () => {
    const actual = await vi.importActual<typeof import("./shared-postgres-need")>("./shared-postgres-need");
    scanMock.mockImplementation(actual.runNeedsSharedPostgres);
    const testPath = join(probeDirectory, "solo.test.ts");
    await writeFile(testPath, 'vi.mock("./deep", () => ({ result: 0 }));\nimport { result } from "./deep";', "utf8");
    await writeFile(join(probeDirectory, "deep.ts"), `export const result = ${Array(6000).fill("1").join(" + ")};`, "utf8");
    const project = fakeProject({ specs: [{ moduleId: testPath }] });

    await expect(callSetup(project)).resolves.toBeUndefined();
    expect(project.provide).not.toHaveBeenCalled();
  });
});
