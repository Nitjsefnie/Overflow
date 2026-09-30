import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CANONICAL_SECTIONS,
  NonCanonicalUnit,
  TRUE_SPELLINGS,
  type UnitEntry,
  type UnitSection,
  isUnderRoot,
  parseUnitFile,
  pathCandidates,
} from "../support/systemd-unit";

/**
 * The closed guard on `deploy/overflow-canary.service`, the unit that keeps the
 * host's one failure-alert delivery path honest.
 *
 * It is closed the way `tests/deploy/alert-units.test.ts` closes the alert
 * template's, and for the same reason: the reviewed set and the pinned set are
 * asserted to be the SAME set, so a directive cannot be admitted by name with
 * its value left open. `StandardOutput=` is why that matters here - systemd
 * opens a `file:` or `append:` target as PID 1, before the mount namespace and
 * before any drop of privilege, so an unpinned value is a root-owned write
 * outside the sandbox rather than a hardening detail.
 *
 * The service runs the same posture as the alert template for the same reason:
 * both read root-only host files at run time, submit mail to the local exim
 * daemon with curl rather than invoking exim in-process (which needs the
 * setgroups() dance the empty capability bounding set removes), and write
 * exactly one thing - the canary's dead-streak marker under
 * /run/overflow-canary, which RuntimeDirectory= grants implicitly, so
 * ReadWritePaths= stays out.
 */
const REVIEWED_CANARY_SERVICE_KEYS: ReadonlySet<string> = new Set([
  "AmbientCapabilities",
  "CapabilityBoundingSet",
  "Environment",
  "ExecStart",
  "LockPersonality",
  "NoNewPrivileges",
  "PrivateDevices",
  "PrivateTmp",
  "ProtectClock",
  "ProtectControlGroups",
  "ProtectHome",
  "ProtectHostname",
  "ProtectKernelLogs",
  "ProtectKernelModules",
  "ProtectKernelTunables",
  "ProtectProc",
  "ProtectSystem",
  "RestrictAddressFamilies",
  "RestrictNamespaces",
  "RestrictRealtime",
  "RestrictSUIDSGID",
  "RuntimeDirectory",
  "RuntimeDirectoryPreserve",
  "StandardError",
  "StandardOutput",
  "SyslogIdentifier",
  "SystemCallArchitectures",
  "SystemCallErrorNumber",
  "SystemCallFilter",
  "Type",
  "UMask",
]);

/** The canary service's `[Unit]` set: a description and nothing else. */
const REVIEWED_CANARY_UNIT_KEYS: ReadonlySet<string> = new Set(["Description"]);

/** The closed key set each section of the canary service is held to. */
const REVIEWED_CANARY_KEYS: ReadonlyMap<UnitSection, ReadonlySet<string>> = new Map([
  ["Unit", REVIEWED_CANARY_UNIT_KEYS],
  ["Service", REVIEWED_CANARY_SERVICE_KEYS],
  ["Install", new Set()],
]);

/** `[Service]` directives pinned to an exact value, each as the only assignment of its key. */
const requiredCanaryServiceValues: ReadonlyArray<readonly [string, string]> = [
  ["CapabilityBoundingSet", ""],
  ["AmbientCapabilities", ""],
  ["ProtectSystem", "strict"],
  ["RuntimeDirectory", "overflow-canary"],
  ["RuntimeDirectoryPreserve", "yes"],
  ["ProtectHome", "yes"],
  ["ProtectProc", "invisible"],
  ["RestrictAddressFamilies", "AF_INET AF_INET6 AF_UNIX"],
  ["SystemCallArchitectures", "native"],
  ["SystemCallFilter", "@system-service"],
  ["SystemCallErrorNumber", "EPERM"],
  ["UMask", "0077"],
  ["Type", "oneshot"],
  ["StandardOutput", "journal"],
  ["StandardError", "journal"],
  ["SyslogIdentifier", "overflow-canary"],
  ["Environment", "PATH=/usr/local/bin:/usr/bin:/bin"],
];

/** `[Service]` directives that must be on, in any spelling systemd reads as true. */
const requiredCanaryServiceSwitches: ReadonlyArray<string> = [
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

/** The canary service's pinned `[Unit]` values. */
const requiredCanaryUnitValues: ReadonlyArray<readonly [string, string]> = [
  ["Description", "Check that the Overflow failure-alert path still delivers"],
];

/** The keys a test of the canary service pins a value for, per section. */
function canaryPinnedKeys(section: UnitSection): ReadonlySet<string> {
  if (section === "Service") {
    return new Set([
      ...requiredCanaryServiceValues.map(([key]) => key),
      ...requiredCanaryServiceSwitches,
      "ExecStart",
    ]);
  }
  if (section === "Unit") {
    return new Set(requiredCanaryUnitValues.map(([key]) => key));
  }

  return new Set();
}

function expectPinnedValue(entry: UnitEntry, required: string): void {
  if (entry.value !== required) {
    throw new NonCanonicalUnit(
      `line ${entry.line} [${entry.section}] ${entry.key} is pinned to ` +
        `"${required}"; write "${entry.key}=${required}" instead of "${entry.key}=${entry.value}"`,
    );
  }
}

describe("Overflow canary service unit", () => {
  let source: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    source = await readFile(resolve("deploy/overflow-canary.service"));
  });

  const entries = (): UnitEntry[] => parseUnitFile(source);

  const only = (section: UnitSection, key: string): UnitEntry => {
    const assignments = entries().filter((entry) => entry.section === section && entry.key === key);

    expect(assignments).toHaveLength(1);
    return assignments[0]!;
  };

  it("parses under systemd's grammar with no shape the guard has to guess at", () => {
    expect(() => parseUnitFile(source)).not.toThrow();
  });

  it.each(CANONICAL_SECTIONS)(
    "pins a value for every directive on the [%s] reviewed set",
    (section) => {
      const reviewed = REVIEWED_CANARY_KEYS.get(section)!;
      const pinned = canaryPinnedKeys(section);

      expect([...reviewed].filter((key) => !pinned.has(key))).toEqual([]);
      expect([...pinned].filter((key) => !reviewed.has(key))).toEqual([]);
    },
  );

  it.each(CANONICAL_SECTIONS)(
    "declares no [%s] directive outside the reviewed set",
    (section) => {
      const reviewed = REVIEWED_CANARY_KEYS.get(section)!;
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

  it("declares no [Install] section, because a timer-triggered unit is never enabled on its own", () => {
    expect(entries().filter((entry) => entry.section === "Install")).toEqual([]);
  });

  it("keeps every path-valued directive out of /root", () => {
    const offending = entries()
      .filter((entry) => pathCandidates(entry).some(isUnderRoot))
      .map((entry) => `${entry.key}=${entry.value}`);

    expect(offending).toEqual([]);
  });

  it.each(requiredCanaryServiceValues)("pins [Service] %s to %s", (key, required) => {
    expectPinnedValue(only("Service", key), required);
  });

  it.each(requiredCanaryServiceSwitches)("turns [Service] %s on", (key) => {
    expect(TRUE_SPELLINGS).toContain(only("Service", key).value.toLowerCase());
  });

  it.each(requiredCanaryUnitValues)("pins [Unit] %s to %s", (key, required) => {
    expectPinnedValue(only("Unit", key), required);
  });

  it("runs the canary script through /bin/sh with no arguments", () => {
    expect(only("Service", "ExecStart").words).toEqual([
      "/bin/sh",
      "/srv/overflow/scripts/overflow-canary.sh",
    ]);
  });

  it("grants no write path outside the runtime directory the marker needs", () => {
    // The exim log and the two host files are read-only to the script, so a
    // ReadWritePaths= here would be a hole with no requirement behind it.
    expect(entries().filter((entry) => entry.key.startsWith("ReadWrite"))).toEqual([]);
  });

  it("stays a oneshot, whose nonzero exit is the failure the timer records", () => {
    expectPinnedValue(only("Service", "Type"), "oneshot");
  });
});

/**
 * The timer's own closed set, read with a parser local to this file.
 *
 * `parseUnitFile` deliberately admits only [Unit], [Service] and [Install],
 * because widening CANONICAL_SECTIONS to reach [Timer] would also widen what
 * the web unit's guard accepts - and a service that grew a [Timer] section
 * would pass. A timer is a file we control completely and it needs nothing
 * exotic, so the parse below is the same discipline applied to a section the
 * shared guard does not model: an unknown section, a repeated header or an
 * assignment that is not `key=value` is a refusal, not a silent pass.
 */
const TIMER_SECTIONS = ["Unit", "Timer", "Install"] as const;
type TimerSection = (typeof TIMER_SECTIONS)[number];

type TimerEntry = { line: number; section: TimerSection; key: string; value: string };

function parseTimer(source: string): TimerEntry[] {
  const entries: TimerEntry[] = [];
  const opened = new Set<TimerSection>();
  let section: TimerSection | null = null;

  source.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    const number = index + 1;

    if (line === "" || line.startsWith("#")) return;

    if (line.startsWith("[")) {
      const name = line.slice(1, -1);
      if (!(TIMER_SECTIONS as ReadonlyArray<string>).includes(name) || line !== `[${name}]`) {
        throw new NonCanonicalUnit(
          `line ${number} is not [Unit], [Timer] or [Install] written exactly: "${line}"`,
        );
      }
      const header = name as TimerSection;
      if (opened.has(header)) {
        throw new NonCanonicalUnit(`line ${number} repeats the [${header}] section header`);
      }
      opened.add(header);
      section = header;
      return;
    }

    const assignment = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
    if (!assignment || section === null) {
      throw new NonCanonicalUnit(
        `line ${number} is neither a section header, an assignment, a "#" comment nor empty: "${line}"`,
      );
    }

    entries.push({
      line: number,
      section,
      key: assignment[1]!,
      value: assignment[2]!,
    });
  });

  return entries;
}

/** The backup's wall-clock schedule, which the canary's must not collide with. */
const BACKUP_CALENDAR = "*-*-* 01:30:00 UTC";

const REVIEWED_TIMER_UNIT_KEYS: ReadonlySet<string> = new Set(["Description"]);
const REVIEWED_TIMER_TIMER_KEYS: ReadonlySet<string> = new Set([
  "OnCalendar",
  "Persistent",
  "Unit",
]);
const REVIEWED_TIMER_INSTALL_KEYS: ReadonlySet<string> = new Set(["WantedBy"]);

const REVIEWED_TIMER_KEYS: ReadonlyMap<TimerSection, ReadonlySet<string>> = new Map([
  ["Unit", REVIEWED_TIMER_UNIT_KEYS],
  ["Timer", REVIEWED_TIMER_TIMER_KEYS],
  ["Install", REVIEWED_TIMER_INSTALL_KEYS],
]);

const requiredTimerValues: ReadonlyMap<TimerSection, ReadonlyArray<readonly [string, string]>> =
  new Map([
    ["Unit", [["Description", "Daily check that the Overflow failure-alert path delivers"]]],
    [
      "Timer",
      [
        ["OnCalendar", "*-*-* 03:20:00 UTC"],
        ["Persistent", "true"],
        ["Unit", "overflow-canary.service"],
      ],
    ],
    ["Install", [["WantedBy", "timers.target"]]],
  ]);

describe("Overflow canary timer unit", () => {
  let source: string = "";

  beforeAll(async () => {
    source = await readFile(resolve("deploy/overflow-canary.timer"), "utf8");
  });

  const entries = (): TimerEntry[] => parseTimer(source);

  const only = (section: TimerSection, key: string): TimerEntry => {
    const assignments = entries().filter((entry) => entry.section === section && entry.key === key);

    expect(assignments).toHaveLength(1);
    return assignments[0]!;
  };

  it("parses as exactly the three sections the guard models", () => {
    expect(() => parseTimer(source)).not.toThrow();
    expect([...new Set(entries().map((entry) => entry.section))].sort()).toEqual([
      "Install",
      "Timer",
      "Unit",
    ]);
  });

  it.each(TIMER_SECTIONS)(
    "declares no [%s] directive outside the reviewed set, and pins every one it does declare",
    (section) => {
      const reviewed = REVIEWED_TIMER_KEYS.get(section)!;
      const pinned = new Set(requiredTimerValues.get(section)!.map(([key]) => key));
      const declared = [
        ...new Set(
          entries()
            .filter((entry) => entry.section === section)
            .map((entry) => entry.key),
        ),
      ];

      expect(declared.filter((key) => !reviewed.has(key))).toEqual([]);
      expect([...reviewed].filter((key) => !pinned.has(key))).toEqual([]);
      expect([...pinned].filter((key) => !reviewed.has(key))).toEqual([]);
    },
  );

  const timerPinCases: ReadonlyArray<readonly [TimerSection, string, string]> = TIMER_SECTIONS.flatMap(
    (section) =>
      requiredTimerValues.get(section)!.map(([key, value]) => [section, key, value] as const),
  );

  it.each(timerPinCases)("pins [%s] %s to %s", (section, key, required) => {
    // Exact spelling, as in the alert guard: the reviewed set admits no key
    // with its value left open, and a value systemd reads differently from
    // the spelling pinned here is a value nobody checked.
    expect(only(section, key).value).toBe(required);
  });

  it("runs daily on a fixed UTC schedule clear of the backup window", () => {
    const calendar = only("Timer", "OnCalendar").value;

    expect(calendar).not.toBe(BACKUP_CALENDAR);
    expect(calendar.endsWith(" UTC"), "a bare wall-clock time moves with the host timezone").toBe(true);
  });

  it("triggers the canary service, so the timer's only effect is that one oneshot", () => {
    expect(only("Timer", "Unit").value).toBe("overflow-canary.service");
  });
});
