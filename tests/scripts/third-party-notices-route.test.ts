import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const routePath = join(repoRoot, "src/app/third-party-notices.txt/route.ts");

it("pins the real release directory across a symlink switch and serves its notices", async () => {
  const root = mkdtempSync(join(tmpdir(), "notices-route-"));
  const previousDistDir = process.env.NEXT_DIST_DIR;
  try {
    const firstRelease = join(root, "release-a");
    const secondRelease = join(root, "release-b");
    const link = join(root, "current");
    mkdirSync(firstRelease);
    mkdirSync(secondRelease);
    writeFileSync(join(firstRelease, "third-party-notices.txt"), "notices from release A\n");
    writeFileSync(join(secondRelease, "third-party-notices.txt"), "notices from release B\n");
    symlinkSync(firstRelease, link, "dir");
    process.env.NEXT_DIST_DIR = "current";

    expect(existsSync(routePath)).toBe(true);
    if (!existsSync(routePath)) return;
    const route = await import(/* @vite-ignore */ pathToFileURL(routePath).href);
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.resolveNoticesFilePath(root)).toBe(join(firstRelease, "third-party-notices.txt"));

    rmSync(link);
    symlinkSync(secondRelease, link, "dir");
    const fixedPath = route.resolveNoticesFilePath(root);
    expect(fixedPath).toBe(join(firstRelease, "third-party-notices.txt"));
    expect(readFileSync(fixedPath, "utf8")).toBe("notices from release A\n");

    const response: Response = await route.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("notices from release A\n");

    rmSync(fixedPath);
    const absent: Response = await route.GET();
    expect(absent.status).toBe(404);
  } finally {
    if (previousDistDir === undefined) delete process.env.NEXT_DIST_DIR;
    else process.env.NEXT_DIST_DIR = previousDistDir;
    rmSync(root, { recursive: true, force: true });
  }
});
