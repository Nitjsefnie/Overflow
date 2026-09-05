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
 *
 * Closed on names is only half of it, and the missing half was a hole: every key
 * here also carries a pinned value, checked by `pins a value for every directive
 * on the reviewed set`. `StandardOutput=` is why. It was admitted by name with
 * its value left open, and systemd opens a `file:`, `append:` or `truncate:`
 * target as PID 1 — as root, before the mount namespace and before the drop to
 * `User=` — so `StandardOutput=truncate:/etc/cron.d/overflow` truncates a
 * root-owned file outside the sandbox on every start, and `append:` writes
 * process-controlled bytes into one. Measured on systemd 257.13: a transient
 * unit with `User=overflow` and `ProtectSystem=strict` created a root-owned file
 * in a directory that is read-only inside its own namespace.
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
  ["Type", "simple"],
  ["Restart", "on-failure"],
  ["RestartSec", "5s"],
  ["StandardOutput", "journal"],
  ["StandardError", "journal"],
  ["SyslogIdentifier", "overflow"],
  ["EnvironmentFile", "/etc/overflow/overflow.env"],
  ["WorkingDirectory", "/srv/overflow"],
];

/**
 * The reviewed keys a test of their own pins rather than one of the tables
 * above, because what they are pinned to is not a single literal value. Listing
 * them here is what lets `pins a value for every directive on the reviewed set`
 * insist that the reviewed set and the pinned set are the same set, so a key
 * cannot be admitted with its value left open.
 */
const separatelyPinnedServiceKeys: ReadonlyMap<string, string> = new Map([
  ["Environment", "pinned as the resolved environment map, last-wins and resets applied"],
  ["ExecStart", "pinned as the whole command vector, token by token"],
  ["MemoryDenyWriteExecute", "pinned absent, or present in a spelling systemd reads as false"],
]);

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

/**
 * The start command, token by token: the interpreter, the script and the whole
 * argument vector. Pinning the spelling of one flag at a time does not hold —
 * Next's bundled commander declares `-p, --port` and `-H, --hostname` as the
 * same options and resolves the last occurrence of either, so `-H 0.0.0.0`
 * appended to a pinned `--hostname 127.0.0.1` moves the listener off the
 * loopback address nginx proxies to; and systemd expands `$VAR` in a command
 * line and word-splits the result, so any argument at all can arrive from
 * `EnvironmentFile=`. An exact vector is the only shape with no residue: the
 * interpreter stays an absolute path outside `/root`, Next's own CLI is started
 * rather than a package manager that would drag corepack and a writable cache
 * in, the listener stays on `127.0.0.1:3000`, and `next dev` cannot stand in
 * for `next start`. Changing the command the service runs is a deliberate edit
 * here as well as in the unit.
 */
const requiredStartCommand: ReadonlyArray<string> = [
  "/usr/local/bin/node",
  "/srv/overflow/node_modules/next/dist/bin/next",
  "start",
  "--hostname",
  "127.0.0.1",
  "--port",
  "3000",
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

  it("parses under systemd's grammar with no shape the guard has to guess at", () => {
    expect(() => parseUnitFile(source)).not.toThrow();
  });

  it("pins a value for every directive on the reviewed set", () => {
    const pinned = new Set([
      ...requiredServiceValues.map(([key]) => key),
      ...requiredServiceSwitches,
      ...separatelyPinnedServiceKeys.keys(),
    ]);

    expect([...REVIEWED_SERVICE_KEYS].filter((key) => !pinned.has(key))).toEqual([]);
    expect([...pinned].filter((key) => !REVIEWED_SERVICE_KEYS.has(key))).toEqual([]);
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

  it("runs exactly the reviewed start command, token by token", () => {
    expect(only("Service", "ExecStart").words).toEqual([...requiredStartCommand]);
  });
});
