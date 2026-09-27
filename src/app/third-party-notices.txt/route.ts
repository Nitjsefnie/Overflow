import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let noticesFilePath: string | undefined;

export function resolveNoticesFilePath(root = process.cwd()): string {
  // Pin the real release at first use. A later .next symlink switch must not
  // change the notices served by this already-running process.
  noticesFilePath ??= join(
    // The target is selected at runtime; tracing it during build would pull
    // the whole project into the route bundle.
    realpathSync(/*turbopackIgnore: true*/ join(
      /*turbopackIgnore: true*/ root, process.env.NEXT_DIST_DIR?.trim() || ".next",
    )),
    "third-party-notices.txt",
  );
  return noticesFilePath;
}

export async function GET(): Promise<Response> {
  try {
    const text = await readFile(/*turbopackIgnore: true*/ resolveNoticesFilePath(), "utf8");
    return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return new Response("Not Found", { status: 404 });
    }
    throw error;
  }
}
