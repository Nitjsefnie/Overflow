import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  FALSE_SPELLINGS,
  TRUE_SPELLINGS,
  type UnitEntry,
  isUnderRoot,
  parseUnitFile,
  pathCandidates,
  toWords,
} from "../support/systemd-unit";

/**
 * Every `[Service]` directive the unit is reviewed to carry. This is a closed
 * set, not a list of what the file happens to say: a directive that is not here
 * fails the suite, so `ExecStartPre=`, `SupplementaryGroups=`,
 * `ReadWriteDirectories=` (systemd's still-live alias for `ReadWritePaths=`) or
 * `BindReadOnlyPaths=` cannot be added without a human putting them here first.
 */
const REVIEWED_SERVICE_KEYS: ReadonlySet<string> = new Set([
  "AmbientCapabilities",
  "CapabilityBoundingSet",
  "Environment",
  "EnvironmentFile",
  "ExecStart",
  "Group",
  "LockPersonality",
  "MemoryDenyWriteExecute",
  "NoNewPrivileges",
  "PrivateDevices",
  "PrivateTmp",
  "ProcSubset",
  "ProtectClock",
  "ProtectControlGroups",
  "ProtectHome",
  "ProtectHostname",
  "ProtectKernelLogs",
  "ProtectKernelModules",
  "ProtectKernelTunables",
  "ProtectProc",
  "ProtectSystem",
  "ReadWritePaths",
  "Restart",
  "RestartSec",
  "RestrictAddressFamilies",
  "RestrictNamespaces",
  "RestrictRealtime",
  "RestrictSUIDSGID",
  "StandardError",
  "StandardOutput",
  "SyslogIdentifier",
  "SystemCallArchitectures",
  "SystemCallErrorNumber",
  "SystemCallFilter",
  "Type",
  "UMask",
  "User",
  "WorkingDirectory",
]);

/**
 * `[Service]` directives pinned to an exact value, each as the only assignment
 * of its key so a reset that a later line widens again fails here. `User` and
 * `Group` are pinned to the dedicated account rather than merely "not root":
 * `nobody` is shared with every other unprivileged service on the host, and
 * `docker` is a root-equivalent group.
 */
const requiredServiceValues: ReadonlyArray<readonly [string, string]> = [
  ["User", "overflow"],
  ["Group", "overflow"],
  ["CapabilityBoundingSet", ""],
  ["AmbientCapabilities", ""],
  ["ProtectSystem", "strict"],
  ["ProtectHome", "yes"],
  ["ReadWritePaths", "/srv/overflow/.next/cache"],
  ["ProtectProc", "invisible"],
  ["ProcSubset", "pid"],
  ["RestrictAddressFamilies", "AF_INET AF_INET6 AF_UNIX"],
  ["SystemCallArchitectures", "native"],
  ["SystemCallFilter", "@system-service"],
  ["SystemCallErrorNumber", "EPERM"],
  ["UMask", "0077"],
];

/** `[Service]` directives that must be on, in any spelling systemd reads as true. */
const requiredServiceSwitches: ReadonlyArray<string> = [
  "NoNewPrivileges",
  "RestrictSUIDSGID",
  "LockPersonality",
  "RestrictRealtime",
  "RestrictNamespaces",
  "PrivateTmp",
  "PrivateDevices",
  "ProtectKernelTunables",
  "ProtectKernelModules",
  "ProtectKernelLogs",
  "ProtectControlGroups",
  "ProtectClock",
  "ProtectHostname",
];

/** The ordering and dependency decisions deploy/README.md's procedure relies on. */
const requiredUnitValues: ReadonlyArray<readonly [string, string]> = [
  ["After", "network-online.target postgresql.service"],
  ["Wants", "network-online.target"],
  ["Requires", "postgresql.service"],
];

/** Without this, `systemctl enable` in deploy/README.md section 6 has nothing to link. */
const requiredInstallValues: ReadonlyArray<readonly [string, string]> = [
  ["WantedBy", "multi-user.target"],
];

/** The environment the unit hands the service, resolved: exactly this, nothing more. */
const requiredEnvironment: Readonly<Record<string, string>> = {
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin",
};

describe("Overflow production unit", () => {
  let source = "";

  beforeAll(async () => {
    source = await readFile(resolve("deploy/overflow.service"), "utf8");
  });

  const entries = (): UnitEntry[] => parseUnitFile(source);

  const sectionEntries = (section: string, key: string): UnitEntry[] =>
    entries().filter((entry) => entry.section === section && entry.key === key);

  const only = (section: string, key: string): UnitEntry => {
    const assignments = sectionEntries(section, key);

    expect(assignments).toHaveLength(1);
    return assignments[0]!;
  };

  const serviceEnvironment = (): Map<string, string> => {
    const environment = new Map<string, string>();

    for (const entry of sectionEntries("Service", "Environment")) {
      if (entry.value === "") {
        environment.clear();
        continue;
      }
      for (const word of entry.words) {
        const separator = word.indexOf("=");

        expect(separator, `Environment= assignment without a name: ${word}`).toBeGreaterThan(0);
        environment.set(word.slice(0, separator), word.slice(separator + 1));
      }
    }

    return environment;
  };

  /** The start command with the `-`/`@` prefixes stripped from the binary only. */
  const execStartCommand = (): string[] => {
    const [binary, ...argv] = only("Service", "ExecStart").words;

    return [(binary ?? "").replace(/^[-@]+/, ""), ...argv];
  };

  const optionValue = (command: string[], option: string): string | undefined => {
    const positions = command.flatMap((token, index) =>
      token === option || token.startsWith(`${option}=`) ? [index] : [],
    );

    expect(positions, `${option} is given ${positions.length} times`).toHaveLength(1);

    const token = command[positions[0]!]!;
    return token === option
      ? command[positions[0]! + 1]
      : token.slice(option.length + 1);
  };

  it("parses under systemd's grammar with no shape the guard has to guess at", () => {
    expect(() => parseUnitFile(source)).not.toThrow();
  });

  it("declares no [Service] directive outside the reviewed set", () => {
    const declared = [
      ...new Set(
        entries()
          .filter((entry) => entry.section === "Service")
          .map((entry) => entry.key),
      ),
    ];

    expect(declared.filter((key) => !REVIEWED_SERVICE_KEYS.has(key))).toEqual([]);
  });

  it("keeps every path-valued directive out of /root", () => {
    only("Service", "WorkingDirectory");
    only("Service", "EnvironmentFile");
    only("Service", "ReadWritePaths");

    const offending = entries()
      .filter((entry) => pathCandidates(entry).some(isUnderRoot))
      .map((entry) => `${entry.key}=${entry.value}`);

    expect(offending).toEqual([]);
  });

  it("gives the service a PATH with no /root component", () => {
    const searchPath = serviceEnvironment().get("PATH");

    expect(searchPath).toBeDefined();
    expect(searchPath!.split(":").filter(isUnderRoot)).toEqual([]);
  });

  it("hands the service exactly the environment it is reviewed to get", () => {
    expect(Object.fromEntries(serviceEnvironment())).toEqual(requiredEnvironment);
  });

  it.each(requiredServiceValues)("pins [Service] %s to %s", (key, required) => {
    expect([...only("Service", key).words].sort()).toEqual(
      [...toWords(key, required)].sort(),
    );
  });

  it.each(requiredServiceSwitches)("turns [Service] %s on", (key) => {
    expect(TRUE_SPELLINGS).toContain(only("Service", key).value.toLowerCase());
  });

  it.each(requiredUnitValues)("pins [Unit] %s to %s", (key, required) => {
    expect([...only("Unit", key).words].sort()).toEqual([...toWords(key, required)].sort());
  });

  it.each(requiredInstallValues)("pins [Install] %s to %s", (key, required) => {
    expect([...only("Install", key).words].sort()).toEqual(
      [...toWords(key, required)].sort(),
    );
  });

  it("leaves MemoryDenyWriteExecute off so V8 can map its JIT pages", () => {
    const enabled = sectionEntries("Service", "MemoryDenyWriteExecute")
      .filter((entry) => !FALSE_SPELLINGS.has(entry.value.toLowerCase()))
      .map((entry) => entry.value);

    expect(enabled).toEqual([]);
  });

  it("does not exempt any Exec command from the sandbox", () => {
    const commands = entries().filter(
      (entry) => entry.section === "Service" && entry.key.startsWith("Exec"),
    );

    expect(commands.length).toBeGreaterThan(0);
    expect(
      commands
        .filter((entry) => !/^[-@]*\//.test(entry.value))
        .map((entry) => `${entry.key}=${entry.value}`),
    ).toEqual([]);
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
