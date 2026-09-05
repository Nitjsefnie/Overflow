import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

type UnitEntry = { section: string; key: string; value: string };

/**
 * Joins directives continued across physical lines with a trailing backslash,
 * so a wrapped ExecStart is parsed as the single assignment systemd sees.
 */
function toLogicalLines(source: string): string[] {
  const logicalLines: string[] = [];
  let carried: string | null = null;

  for (const physicalLine of source.split(/\r?\n/)) {
    const line: string =
      carried === null ? physicalLine : `${carried} ${physicalLine.trim()}`;

    if (line.endsWith("\\")) {
      carried = line.slice(0, -1).trimEnd();
      continue;
    }

    carried = null;
    logicalLines.push(line);
  }

  if (carried !== null) {
    logicalLines.push(carried);
  }

  return logicalLines;
}

/**
 * Parses a systemd unit into its assignments. Comments are dropped, keys are
 * scoped to their section, and every assignment of a repeated key is kept in
 * file order: a directive that is commented out, or reset and then widened
 * further down, must not read as the hardened one.
 */
function parseUnitFile(source: string): UnitEntry[] {
  const entries: UnitEntry[] = [];
  let section = "";

  for (const logicalLine of toLogicalLines(source)) {
    const line = logicalLine.trim();

    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionHeader = /^\[(.+)\]$/.exec(line);
    if (sectionHeader) {
      section = sectionHeader[1]!.trim();
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }

    entries.push({
      section,
      key: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
    });
  }

  return entries;
}

function isUnderRoot(pathValue: string): boolean {
  return pathValue === "/root" || pathValue.startsWith("/root/");
}

function tokens(value: string): string[] {
  return value.split(/\s+/).filter((token) => token !== "");
}

/** Values a directive may name a path in: whitespace, PATH colons, `NAME=value`. */
function pathCandidates(value: string): string[] {
  return value.split(/[\s:=]+/).filter((candidate) => candidate !== "");
}

/**
 * Every hardening directive the unit must carry, with the value it must carry
 * it at. Each is asserted as the only assignment of its key, so a reset that a
 * later line widens again fails here.
 */
const requiredServiceSettings: ReadonlyArray<readonly [string, string]> = [
  ["NoNewPrivileges", "yes"],
  ["CapabilityBoundingSet", ""],
  ["AmbientCapabilities", ""],
  ["RestrictSUIDSGID", "yes"],
  ["LockPersonality", "yes"],
  ["RestrictRealtime", "yes"],
  ["RestrictNamespaces", "yes"],
  ["ProtectSystem", "strict"],
  ["ProtectHome", "yes"],
  ["PrivateTmp", "yes"],
  ["PrivateDevices", "yes"],
  ["ReadWritePaths", "/srv/overflow/.next/cache"],
  ["ProtectKernelTunables", "yes"],
  ["ProtectKernelModules", "yes"],
  ["ProtectKernelLogs", "yes"],
  ["ProtectControlGroups", "yes"],
  ["ProtectClock", "yes"],
  ["ProtectHostname", "yes"],
  ["ProtectProc", "invisible"],
  ["ProcSubset", "pid"],
  ["RestrictAddressFamilies", "AF_INET AF_INET6 AF_UNIX"],
  ["SystemCallArchitectures", "native"],
  ["SystemCallFilter", "@system-service"],
  ["SystemCallErrorNumber", "EPERM"],
];

describe("systemd unit parsing", () => {
  it("drops commented directives and scopes keys to their section", () => {
    const parsed = parseUnitFile(
      [
        "[Unit]",
        "Description=example",
        "",
        "[Service]",
        "# ProtectSystem=strict",
        "  ; User=root",
        "User=overflow",
        "Environment=PATH=/usr/bin",
      ].join("\n"),
    );

    expect(parsed).toEqual([
      { section: "Unit", key: "Description", value: "example" },
      { section: "Service", key: "User", value: "overflow" },
      { section: "Service", key: "Environment", value: "PATH=/usr/bin" },
    ]);
  });

  it("keeps every assignment of a repeated key in file order", () => {
    const parsed = parseUnitFile(
      "[Service]\nCapabilityBoundingSet=\nCapabilityBoundingSet=CAP_SYS_ADMIN\n",
    );

    expect(parsed.map((entry) => entry.value)).toEqual(["", "CAP_SYS_ADMIN"]);
  });

  it("joins a directive continued across physical lines", () => {
    const parsed = parseUnitFile(
      "[Service]\nExecStart=/usr/local/bin/node \\\n  /srv/overflow/next start\n",
    );

    expect(parsed).toEqual([
      {
        section: "Service",
        key: "ExecStart",
        value: "/usr/local/bin/node /srv/overflow/next start",
      },
    ]);
  });
});

describe("Overflow production unit", () => {
  let unit: UnitEntry[] = [];

  beforeAll(async () => {
    unit = parseUnitFile(await readFile(resolve("deploy/overflow.service"), "utf8"));
  });

  const serviceValues = (key: string): string[] =>
    unit.filter((entry) => entry.section === "Service" && entry.key === key)
      .map((entry) => entry.value);

  const environment = (name: string): string | undefined => {
    for (const assignment of serviceValues("Environment")) {
      const separator = assignment.indexOf("=");
      if (separator !== -1 && assignment.slice(0, separator).trim() === name) {
        return assignment.slice(separator + 1).trim();
      }
    }
    return undefined;
  };

  const execStartCommand = (): string[] => {
    const assignments = serviceValues("ExecStart");
    expect(assignments).toHaveLength(1);
    return tokens(assignments[0]!.replace(/^[-@]+/, ""));
  };

  const optionValue = (command: string[], option: string): string | undefined =>
    command[command.indexOf(option) + 1];

  it.each(["User", "Group"])("runs under a %s that is not the superuser", (key) => {
    const assignments = serviceValues(key);

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).not.toBe("");
    expect(["root", "0"]).not.toContain(assignments[0]);
  });

  it("keeps every path-valued directive out of /root", () => {
    expect(serviceValues("WorkingDirectory")).toHaveLength(1);
    expect(serviceValues("EnvironmentFile")).toHaveLength(1);
    expect(serviceValues("ReadWritePaths")).toHaveLength(1);
    expect(execStartCommand()).not.toHaveLength(0);

    const offending = unit
      .filter((entry) => pathCandidates(entry.value).some(isUnderRoot))
      .map((entry) => `${entry.key}=${entry.value}`);

    expect(offending).toEqual([]);
  });

  it("gives the service a PATH with no /root component", () => {
    const searchPath = environment("PATH");

    expect(searchPath).toBeDefined();
    expect(searchPath!.split(":").filter(isUnderRoot)).toEqual([]);
  });

  it.each(requiredServiceSettings)("restricts %s to %s", (key, required) => {
    const assignments = serviceValues(key);

    expect(assignments).toHaveLength(1);
    expect(tokens(assignments[0]!).sort()).toEqual(tokens(required).sort());
  });

  it("leaves MemoryDenyWriteExecute off so V8 can map its JIT pages", () => {
    const enabled = serviceValues("MemoryDenyWriteExecute")
      .filter((value) => value.toLowerCase() !== "no");

    expect(enabled).toEqual([]);
  });

  it("does not exempt the start command from the sandbox", () => {
    const assignments = serviceValues("ExecStart");

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatch(/^[-@]*\//);
  });

  it("starts Next directly rather than through a package manager", () => {
    const command = execStartCommand();

    expect(command[0]).toMatch(/^\//);
    expect(
      command.filter((token) => /(^|\/)(pnpm|pnpx|npm|npx|yarn|corepack)$/.test(token)),
    ).toEqual([]);
  });

  it("binds the loopback listener nginx proxies to", () => {
    const command = execStartCommand();

    expect(optionValue(command, "--hostname")).toBe("127.0.0.1");
    expect(optionValue(command, "--port")).toBe("3000");
  });
});
