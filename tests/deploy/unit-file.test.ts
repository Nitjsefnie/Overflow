import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CANONICAL_SECTIONS,
  FALSE_SPELLINGS,
  NonCanonicalUnit,
  TRUE_SPELLINGS,
  type UnitEntry,
  type UnitSection,
  isUnderRoot,
  parseUnitFile,
  pathCandidates,
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
  "SuccessExitStatus",
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
  ["SuccessExitStatus", "143"],
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
  ["Environment", "pinned as the unit's Environment= map, last-wins and resets applied"],
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

/**
 * Every `[Unit]` directive the unit is reviewed to carry, closed the same way
 * `[Service]` is.
 *
 * `[Service]` is not the only section that can weaken the sandbox, and leaving
 * this one open was a hole: `JoinsNamespaceOf=postgresql.service` in `[Unit]`
 * puts the service inside another unit's namespaces, so `PrivateTmp=yes` stays
 * set and stops being private. Measured on systemd 257.13 with three transient
 * units: one wrote a file into its own private `/tmp`, a second carrying
 * `PrivateTmp=yes` *and* `JoinsNamespaceOf=` read that file back, and the
 * control carrying `PrivateTmp=yes` alone saw an empty `/tmp`. The same
 * directive shares the network and IPC namespaces where the joined unit has
 * `PrivateNetwork=` or `PrivateIPC=`.
 *
 * `OnFailure=` starts another unit when this one enters the failed state. Its
 * pinned value is the alert template with this unit's name as the instance, so
 * a failure of the web application mails the tail of its own journal to the
 * address in the host-only recipient file;
 * `tests/deploy/alert-units.test.ts` closes the template unit's own set.
 */
const REVIEWED_UNIT_KEYS: ReadonlySet<string> = new Set([
  "After",
  "Description",
  "OnFailure",
  "Requires",
  "StartLimitBurst",
  "StartLimitIntervalSec",
  "Wants",
]);

/** Every `[Install]` directive the unit is reviewed to carry, closed likewise. */
const REVIEWED_INSTALL_KEYS: ReadonlySet<string> = new Set(["WantedBy"]);

/**
 * The ordering and dependency decisions deploy/README.md's procedure relies on,
 * plus the description, which is pinned because the closed set above admits no
 * key with its value left open.
 */
const requiredUnitValues: ReadonlyArray<readonly [string, string]> = [
  ["Description", "Overflow production web application"],
  ["After", "network-online.target postgresql.service"],
  ["Wants", "network-online.target"],
  ["Requires", "postgresql.service"],
  ["OnFailure", "overflow-alert@%n.service"],
  ["StartLimitIntervalSec", "300"],
  ["StartLimitBurst", "5"],
];

/** Without this, `systemctl enable` in deploy/README.md section 6 has nothing to link. */
const requiredInstallValues: ReadonlyArray<readonly [string, string]> = [
  ["WantedBy", "multi-user.target"],
];

/** The closed key set each section is held to. */
const REVIEWED_KEYS: ReadonlyMap<UnitSection, ReadonlySet<string>> = new Map([
  ["Unit", REVIEWED_UNIT_KEYS],
  ["Service", REVIEWED_SERVICE_KEYS],
  ["Install", REVIEWED_INSTALL_KEYS],
]);

/** The keys a test of this file pins a value for, per section. */
function pinnedKeys(section: UnitSection): ReadonlySet<string> {
  if (section === "Service") {
    return new Set([
      ...requiredServiceValues.map(([key]) => key),
      ...requiredServiceSwitches,
      ...separatelyPinnedServiceKeys.keys(),
    ]);
  }

  const values = section === "Unit" ? requiredUnitValues : requiredInstallValues;

  return new Set(values.map(([key]) => key));
}

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

/**
 * The unit's own Environment= assignments, with resets and last-wins applied.
 * EnvironmentFile= is pinned separately to the reviewed path. Its root-owned
 * contents are outside this repository and take precedence over Environment=;
 * this map does not establish the environment the process actually receives.
 */
const requiredEnvironment: Readonly<Record<string, string>> = {
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin",
};

/**
 * The start command's tokens, with a `--name=value` argument written as the two
 * tokens it stands for.
 *
 * That is the only equivalence the pin allows, and it is not a guess:
 * checked against the commander build Next actually bundles in this tree,
 * `next start --hostname=127.0.0.1 --port=3000` resolves to the same options as
 * the space-separated spelling. Nothing else is normalised, so the short
 * aliases stay visible as the extra tokens they are — `-H 0.0.0.0` and the
 * attached `-H0.0.0.0`, both of which that same check showed do move the
 * listener, do not match this vector and never will.
 */
function startCommandTokens(command: ReadonlyArray<string>): string[] {
  return command.flatMap((token) => {
    const joined = /^(--[^=]+)=(.*)$/.exec(token);

    return joined ? [joined[1]!, joined[2]!] : [token];
  });
}

function expectPinnedValue(entry: UnitEntry, required: string): void {
  if (entry.value !== required) {
    throw new NonCanonicalUnit(
      `rule 6 (exact pinned spelling): line ${entry.line} [${entry.section}] ${entry.key} is pinned to ` +
        `"${required}"; write "${entry.key}=${required}" instead of "${entry.key}=${entry.value}"`,
    );
  }
}

describe("canonical pinned values", () => {
  it.each([
    ["Service", "ProtectHome", "true", "yes"],
    ["Service", "UMask", "077", "0077"],
    ["Service", "RestrictAddressFamilies", "AF_UNIX AF_INET6 AF_INET", "AF_INET AF_INET6 AF_UNIX"],
    ["Unit", "Description", "Overflow  production web application", "Overflow production web application"],
    ["Install", "WantedBy", "multi-user.target multi-user.target", "multi-user.target"],
  ])("refuses [%s] %s=%s with the exact spelling to use", (section, key, value, required) => {
    const entry = parseUnitFile(`[${section}]\n${key}=${value}\n`)[0]!;

    expect(() => expectPinnedValue(entry, required)).toThrow(
      `rule 6 (exact pinned spelling): line 2 [${section}] ${key} is pinned to ` +
        `"${required}"; write "${key}=${required}" instead of "${key}=${value}"`,
    );
  });
});

describe("start command tokens", () => {
  it.each([
    [["--hostname=127.0.0.1"], ["--hostname", "127.0.0.1"]],
    [["--hostname", "127.0.0.1"], ["--hostname", "127.0.0.1"]],
    [["--port=3000", "--hostname=0.0.0.0"], ["--port", "3000", "--hostname", "0.0.0.0"]],
    [["-H0.0.0.0"], ["-H0.0.0.0"]],
    [["-H", "0.0.0.0"], ["-H", "0.0.0.0"]],
    [
      ["/srv/overflow/node_modules/next/dist/bin/next", "start"],
      ["/srv/overflow/node_modules/next/dist/bin/next", "start"],
    ],
  ])("reads %j as %j", (command, expected) => {
    expect(startCommandTokens(command)).toEqual(expected);
  });
});

describe("Overflow production unit", () => {
  it("keeps deploy limited to the reviewed unit and operator procedure", async () => {
    const files = await readdir(resolve("deploy"), { withFileTypes: true });

    expect(files.map((file) => file.name).sort(),
      "deploy/ may contain only README.md, backup-restore.md, container.md, " +
        "decommission.md, dpia-screening.md, incident-response.md, " +
        "overflow-alert@.service, " +
        "overflow-backup.service, overflow-backup.timer, overflow-bounce.service, " +
        "overflow-bounce.timer, overflow-canary.service, overflow-canary.timer, " +
        "overflow-offhost-backup.service, overflow-offhost-backup.timer " +
        "and overflow.service; " +
        "review additions alongside the install procedure",
    ).toEqual([
      "README.md",
      "backup-restore.md",
      "container.md",
      "decommission.md",
      "dpia-screening.md",
      "incident-response.md",
      "overflow-alert@.service",
      "overflow-backup.service",
      "overflow-backup.timer",
      "overflow-bounce.service",
      "overflow-bounce.timer",
      "overflow-canary.service",
      "overflow-canary.timer",
      "overflow-offhost-backup.service",
      "overflow-offhost-backup.timer",
      "overflow.service",
    ]);
    expect(files.filter((file) => !file.isFile()).map((file) => file.name),
      "the reviewed deployment artifacts must be regular files",
    ).toEqual([]);
  });

  /**
   * The unit as bytes, not as a decoded string: the canonical subset is a rule
   * about what is on disk, and a decoder standing between the file and the
   * guard is one more thing that can turn a byte systemd rejects into one the
   * guard accepts.
   */
  let source: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    source = await readFile(resolve("deploy/overflow.service"));
  });

  const entries = (): UnitEntry[] => parseUnitFile(source);

  const sectionEntries = (section: UnitSection, key: string): UnitEntry[] =>
    entries().filter((entry) => entry.section === section && entry.key === key);

  const only = (section: UnitSection, key: string): UnitEntry => {
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

  it.each(CANONICAL_SECTIONS)(
    "pins a value for every directive on the [%s] reviewed set",
    (section) => {
      const reviewed = REVIEWED_KEYS.get(section)!;
      const pinned = pinnedKeys(section);

      expect([...reviewed].filter((key) => !pinned.has(key))).toEqual([]);
      expect([...pinned].filter((key) => !reviewed.has(key))).toEqual([]);
    },
  );

  it.each(CANONICAL_SECTIONS)(
    "declares no [%s] directive outside the reviewed set",
    (section) => {
      const reviewed = REVIEWED_KEYS.get(section)!;
      const declared = [
        ...new Set(
          entries()
            .filter((entry) => entry.section === section)
            .map((entry) => entry.key),
        ),
      ];

      expect(declared.filter((key) => !reviewed.has(key))).toEqual([]);
    },
  );

  it("keeps every path-valued directive out of /root", () => {
    only("Service", "WorkingDirectory");
    only("Service", "EnvironmentFile");
    only("Service", "ReadWritePaths");

    const offending = entries()
      .filter((entry) => pathCandidates(entry).some(isUnderRoot))
      .map((entry) => `${entry.key}=${entry.value}`);

    expect(offending).toEqual([]);
  });

  it("declares a PATH in Environment= with no /root component", () => {
    const searchPath = serviceEnvironment().get("PATH");

    expect(searchPath).toBeDefined();
    expect(searchPath!.split(":").filter(isUnderRoot)).toEqual([]);
  });

  it("pins the unit's own Environment= assignments to the reviewed map", () => {
    expect(Object.fromEntries(serviceEnvironment())).toEqual(requiredEnvironment);
  });

  it.each(requiredServiceValues)("pins [Service] %s to %s", (key, required) => {
    expectPinnedValue(only("Service", key), required);
  });

  it.each(requiredServiceSwitches)("turns [Service] %s on", (key) => {
    expect(TRUE_SPELLINGS).toContain(only("Service", key).value.toLowerCase());
  });

  it.each(requiredUnitValues)("pins [Unit] %s to %s", (key, required) => {
    expectPinnedValue(only("Unit", key), required);
  });

  it.each(requiredInstallValues)("pins [Install] %s to %s", (key, required) => {
    expectPinnedValue(only("Install", key), required);
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
    expect(startCommandTokens(only("Service", "ExecStart").words)).toEqual([
      ...requiredStartCommand,
    ]);
  });
});

describe("Overflow off-host backup units", () => {
  /**
   * The off-host job speaks to the Discord API through the mailbox CLI, a
   * python3 script under /root that the full-backup unit never touches. On
   * this host's systemd 257.13 the obvious pairing is inoperative:
   * ProtectHome=yes voids BindReadOnlyPaths destinations under the protected
   * directories, so the shipped `ProtectHome=yes` + bind pairing cannot read
   * the CLI at all — probed on this host with a transient service carrying
   * the unit's full sandbox set (CONTROL-NOT-READABLE). The man page's
   * sanctioned pairing, proven readable by the same probe (TMPFS-READABLE),
   * is what this file pins: ProtectHome=tmpfs mounts /root empty and the bind
   * then mounts the one file back in.
   */
  let offhostUnits: Buffer = Buffer.alloc(0);
  let offhostTimerSource: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    offhostUnits = await readFile(resolve("deploy/overflow-offhost-backup.service"));
    offhostTimerSource = await readFile(resolve("deploy/overflow-offhost-backup.timer"));
  });

  const entries = (): UnitEntry[] => parseUnitFile(offhostUnits);
  const only = (section: UnitSection, key: string): UnitEntry => {
    const assignments = entries().filter((entry) => entry.section === section && entry.key === key);

    expect(assignments, `${section} ${key} appears at most once`).toHaveLength(1);
    return assignments[0]!;
  };

  it("parses under systemd's grammar with no shape the guard has to guess at", () => {
    // The service unit only; the shared parser is closed to [Timer] by
    // design, and the timer is pinned by exact lines in its own test below.
    expect(() => parseUnitFile(offhostUnits)).not.toThrow();
  });

  it("runs the off-host script under /bin/sh, oneshot, off the backup env file", () => {
    expect(only("Service", "Type").value).toBe("oneshot");
    expect(only("Service", "ExecStart").words).toEqual([
      "/bin/sh",
      "/srv/overflow/scripts/db-offhost-backup.sh",
    ]);
    expect(only("Service", "EnvironmentFile").value).toBe("/etc/overflow/backup.env");
    expect(only("Unit", "OnFailure").value).toBe("overflow-alert@%n.service");
  });

  it("reaches the mailbox CLI through the tmpfs ProtectHome with exactly one bound file", () => {
    // The shipped mechanism, as probed on this host. ProtectHome=yes would
    // void the bind destination under /root (see the describe comment); the
    // tmpfs spelling is the pairing systemd.exec(5) sanctions and the probe
    // proved readable.
    expect(only("Service", "ProtectHome").value).toBe("tmpfs");
    const binds = entries().filter((entry) => entry.key === "BindReadOnlyPaths");

    expect(binds, "exactly the mailbox CLI file is bound back in").toHaveLength(1);
    expect(binds[0]!.value).toBe("/root/.agent-bundle/scripts/discord_mb.py");
  });

  it("loads the osc token from its canonical file as a credential", () => {
    // The copy in /etc/overflow/backup.env is what a rotation silently broke:
    // the unit reads the token from the canonical file at every start, so a
    // rotation needs no Overflow-side edit. PID 1 opens the file before the
    // sandbox is assembled and hands the content over through
    // CREDENTIALS_DIRECTORY, which the script bridges to DISCORD_TOKEN.
    const credentials = entries().filter((entry) => entry.key === "LoadCredential");

    expect(credentials, "exactly one credential is loaded").toHaveLength(1);
    expect(credentials[0]!.section).toBe("Service");
    expect(credentials[0]!.value).toBe("osc_token:/root/.agent-bundle/discord/osc.token");
  });

  it("keeps the rest of the full-backup sandbox, with /root touched only by the bind and the credential", () => {
    expect(only("Service", "ProtectSystem").value).toBe("strict");
    expect(only("Service", "PrivateTmp").value).toBe("yes");
    expect(only("Service", "ReadWritePaths").value).toBe("/var/backups/overflow");
    expect(only("Service", "UMask").value).toBe("0077");
    expect(TRUE_SPELLINGS).toContain(only("Service", "NoNewPrivileges").value.toLowerCase());
    expect(only("Service", "CapabilityBoundingSet").value).toBe("");

    // tmpfs makes /root an empty mount; the bound CLI file and the
    // credential's canonical source are the only /root paths any directive
    // may name. The credential is read by PID 1 before the sandbox is
    // assembled, so it is not a file the namespace reaches into.
    const rootTouching = entries()
      .filter((entry) => pathCandidates(entry).some(isUnderRoot))
      .map((entry) => entry.key);

    expect(rootTouching, "/root appears only through the bound CLI and the credential").toEqual([
      "BindReadOnlyPaths",
      "LoadCredential",
    ]);
    const environment = entries().filter(
      (entry) => entry.section === "Service" && entry.key === "Environment",
    );
    expect(environment, "PATH and HOME, one Environment= line each").toHaveLength(2);
    expect(
      environment.flatMap((entry) => entry.words).filter((word) => word.startsWith("PATH=")),
      "the PATH carries no /root component",
    ).toEqual(["PATH=/usr/local/bin:/usr/bin:/bin"]);
  });

  it("gives the connector a writable HOME on the private /tmp the unit already owns", () => {
    // The mailbox library derives its connector lock root from the home
    // directory with no override, and ProtectHome=tmpfs mounts /root as an
    // empty READ-ONLY tmpfs, so the stock HOME=/root is where connectors go
    // to die ([Errno 30] Read-only file system, measured on the first manual
    // run). HOME=/tmp moves the lock root into the private /tmp the sandbox
    // already provides; nothing under /root becomes writable, and the osc
    // token is not home-based, so no secret follows the move.
    const homes = entries()
      .filter((entry) => entry.section === "Service" && entry.key === "Environment")
      .flatMap((entry) => entry.words)
      .filter((word) => word.startsWith("HOME="));

    expect(homes, "exactly one HOME assignment").toHaveLength(1);
    expect(homes[0]).toBe("HOME=/tmp");
  });

  it("fires the timer at 02:10 UTC, persistently, at the off-host unit", () => {
    // The shared parser is deliberately closed to the three sections the
    // reviewed unit uses; a [Timer] section is refused by design, so the
    // timer is pinned by exact directive lines instead of by parseUnitFile.
    const timerLines = offhostTimerSource.toString("utf8").split("\n");

    for (const line of [
      "OnCalendar=*-*-* 02:10:00 UTC",
      "Persistent=true",
      "Unit=overflow-offhost-backup.service",
      "WantedBy=timers.target",
    ]) {
      expect(timerLines, `${line} must appear verbatim in the timer`).toContain(line);
    }
  });
});
