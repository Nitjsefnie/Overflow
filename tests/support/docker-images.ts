import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; encoding?: "utf8"; stdio?: ["ignore", "pipe", "pipe"] },
) => Buffer | string | void;

export function createDockerImageSuite(
  run: CommandRunner,
  log: (line: string) => void = (line) => writeSync(2, `${line}\n`),
) {
  const runId = randomUUID();

  function removeImage(tag: string): void {
    try {
      run("docker", ["image", "rm", tag], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (removeError) {
      // A failed build may never have applied its tag. Confirm absence rather
      // than treating every failed removal as harmless.
      try {
        run("docker", ["image", "inspect", tag], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (inspectError) {
        const stderr = (inspectError as { stderr?: Buffer | string }).stderr;
        if (stderr !== undefined && String(stderr).includes(`No such image: ${tag}`)) return;
      }
      throw removeError;
    }
  }

  function withBuiltImage<T>(baseName: string, repoRoot: string, sourceSha: string, body: (tag: string) => T): T {
    const tag = `${baseName}:${runId}`;
    let failed = false;
    let primaryError: unknown;
    try {
      run("docker", ["build", "--build-arg", `SOURCE_SHA=${sourceSha}`, "--label", `overflow.test-run=${runId}`, "-t", tag, "."], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const imageId = run("docker", ["image", "inspect", "--format", "{{.Id}}", tag], { encoding: "utf8" });
      log(`Built test image ${tag} ${String(imageId).trim()}`);
      return body(tag);
    } catch (error) {
      failed = true;
      primaryError = error;
      throw error;
    } finally {
      try {
        removeImage(tag);
      } catch (cleanupError) {
        if (failed) {
          throw new AggregateError([primaryError, cleanupError], `Image test and cleanup both failed for ${tag}`);
        }
        throw cleanupError;
      }
    }
  }

  return { withBuiltImage };
}
