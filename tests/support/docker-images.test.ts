import { describe, expect, it } from "vitest";

import { createDockerImageSuite } from "./docker-images";

type Command = { command: string; args: string[] };
const silentLog = () => {};

function recorder() {
  const commands: Command[] = [];
  const run = (command: string, args: string[]) => {
    commands.push({ command, args });
    return args[0] === "image" && args[1] === "inspect" ? "sha256:built-image\n" : "";
  };
  return { commands, run };
}

function builtTag(commands: Command[]) {
  const build = commands.find(({ args }) => args[0] === "build");
  expect(build).toBeDefined();
  return build!.args[build!.args.indexOf("-t") + 1]!;
}

describe("Docker image suite", () => {
  it("reports the built tag and image ID through the supplied logger", () => {
    const { commands, run } = recorder();
    const records: unknown[] = [];

    createDockerImageSuite(run, (record) => records.push(record))
      .withBuiltImage("overflow-576-license", "/repo", "source", () => {});

    expect(records).toEqual([{ event: "built", tag: builtTag(commands), imageId: "sha256:built-image" }]);
  });

  it("gives concurrent suites distinct lowercase tags and labels", () => {
    const first = recorder();
    const second = recorder();

    createDockerImageSuite(first.run, silentLog).withBuiltImage("overflow-576-license", "/repo", "source", () => {});
    createDockerImageSuite(second.run, silentLog).withBuiltImage("overflow-576-license", "/repo", "source", () => {});

    const firstTag = builtTag(first.commands);
    const secondTag = builtTag(second.commands);
    expect(firstTag).toMatch(/^overflow-576-license:[a-z0-9-]+$/);
    expect(secondTag).toMatch(/^overflow-576-license:[a-z0-9-]+$/);
    expect(firstTag).not.toBe(secondTag);
    for (const commands of [first.commands, second.commands]) {
      const build = commands.find(({ args }) => args[0] === "build")!;
      const label = build.args[build.args.indexOf("--label") + 1]!;
      expect(label).toBe(`overflow.test-run=${builtTag(commands).split(":")[1]}`);
    }
  });

  it("removes each built tag after its body finishes", () => {
    const { commands, run } = recorder();
    const suite = createDockerImageSuite(run, silentLog);
    const inspected: string[] = [];

    for (const base of ["overflow-576-license", "overflow-444-configuser", "overflow-688-prod-only"]) {
      suite.withBuiltImage(base, "/repo", "source", (tag) => inspected.push(tag));
    }

    expect(inspected).toEqual(commands.filter(({ args }) => args[0] === "build").map(({ args }) => args[args.indexOf("-t") + 1]));
    expect(commands.filter(({ args }) => args[0] === "image" && args[1] === "rm").map(({ args }) => args[2])).toEqual(inspected);
    expect(new Set(inspected.map((tag) => tag.split(":")[1])).size).toBe(1);
  });

  it("removes its tag and preserves the body failure", () => {
    const { commands, run } = recorder();
    const failure = new Error("assertion failed");
    let caught: unknown;
    let threw = false;

    try {
      createDockerImageSuite(run, silentLog).withBuiltImage("overflow-576-license", "/repo", "source", () => {
        throw failure;
      });
    } catch (error) {
      threw = true;
      caught = error;
    }
    expect(threw, "the body failure must be thrown").toBe(true);
    expect(caught).toBe(failure);
    expect(commands.some(({ args }) => args[0] === "image" && args[1] === "rm" && args[2] === builtTag(commands))).toBe(true);
  });

  it("attempts removal when the build throws and tolerates the absent tag", () => {
    const commands: Command[] = [];
    const buildFailure = new Error("build failed");
    let caught: unknown;
    let threw = false;
    const run = (command: string, args: string[]) => {
      commands.push({ command, args });
      if (args[0] === "build") throw buildFailure;
      if (args[0] === "image" && args[1] === "rm") throw new Error("rm failed");
      if (args[0] === "image" && args[1] === "inspect") {
        throw Object.assign(new Error("missing"), { stderr: Buffer.from(`Error: No such image: ${args[2]}`) });
      }
      return "";
    };

    try {
      createDockerImageSuite(run, silentLog).withBuiltImage("overflow-576-license", "/repo", "source", () => {});
    } catch (error) {
      threw = true;
      caught = error;
    }
    expect(threw, "the build failure must be thrown").toBe(true);
    expect(caught).toBe(buildFailure);
    expect(commands.map(({ args }) => args.slice(0, 2))).toEqual([["build", "--build-arg"], ["image", "rm"], ["image", "inspect"]]);
  });

  it("surfaces a removal failure while the image still exists", () => {
    const removalFailure = new Error("image is in use");
    let caught: unknown;
    let threw = false;
    const run = (_command: string, args: string[]) => {
      if (args[0] === "image" && args[1] === "rm") throw removalFailure;
      return args[0] === "image" && args[1] === "inspect" ? "sha256:built-image\n" : "";
    };

    try {
      createDockerImageSuite(run, silentLog).withBuiltImage("overflow-576-license", "/repo", "source", () => {});
    } catch (error) {
      threw = true;
      caught = error;
    }
    expect(threw, "the removal failure must be thrown").toBe(true);
    expect(caught).toBe(removalFailure);
  });

  it("reports both the body failure and a real removal failure", () => {
    const bodyFailure = new Error("assertion failed");
    const removalFailure = new Error("image is in use");
    const run = (_command: string, args: string[]) => {
      if (args[0] === "image" && args[1] === "rm") throw removalFailure;
      return args[0] === "image" && args[1] === "inspect" ? "sha256:built-image\n" : "";
    };

    let caught: unknown;
    let threw = false;
    try {
      createDockerImageSuite(run, silentLog).withBuiltImage("overflow-576-license", "/repo", "source", () => {
        throw bodyFailure;
      });
    } catch (error) {
      threw = true;
      caught = error;
    }
    expect(threw, "both failures must be reported").toBe(true);
    expect(caught).toBeInstanceOf(AggregateError);
    const errors = (caught as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(bodyFailure);
    expect(errors[1]).toBe(removalFailure);
  });
});
