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
 * The closed guard on `deploy/overflow-bounce.service`, the unit that runs the
 * bounce watcher - the reporting leg of the failure-alert route: a root-run
 * oneshot that tails the mail spool from a persisted byte offset and forwards
 * each new delivery-failure notification to the out-of-band Discord webhook.
 *
 * It is closed the way `tests/deploy/canary-units.test.ts` closes the canary
 * service's, and for the same reason: the reviewed set and the pinned set are
 * asserted to be the SAME set, so a directive cannot be admitted by name with
 * its value left open. `StandardOutput=` is the standing example of what an
 * unpinned value costs - systemd opens a `file:` or `append:` target as PID 1,
 * before the mount namespace and before any drop of privilege, so an unpinned
 * value there is a root-owned write outside the sandbox.
 *
 * The service runs the canary's posture with two deltas. The state it keeps
 * is the spool offset, which must survive reboots, so it lives in a
 * `StateDirectory=` (/var/lib/overflow-bounce) and not the canary's
 * `RuntimeDirectory=` (/run is wiped at boot - the canary's dead-streak
 * marker may be lost at reboot, the bounce offset may not). Under
 * `ProtectSystem=strict` the state directory is granted read-write
 * implicitly, so `ReadWritePaths=` stays out and the spool and the root-only
 * webhook file stay read-only-readable. And unlike the canary it carries one
 * capability: the spool is the MTA's delivery state (mail:mail, mode 0600 on
 * the deployed host), an empty bounding set strips CAP_DAC_OVERRIDE, and
 * root's plain open of the spool is then denied under this unit's posture -
 * measured, not assumed: every run exited 2 at the spool readability check.
 * The grant is pinned to the EXACT single token, so a second capability in
 * either directive fails the pin; the closed key set is what rejects the
 * canary's SupplementaryGroups= repair shape, which was tested and does not
 * work here (a 0600 file carries zero group bits).
 */
const REVIEWED_BOUNCE_SERVICE_KEYS: ReadonlySet<string> = new Set([
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
  "StandardError",
  "StandardOutput",
  "StateDirectory",
  "SyslogIdentifier",
  "SystemCallArchitectures",
  "SystemCallErrorNumber",
  "SystemCallFilter",
  "Type",
  "UMask",
]);

/** The bounce service's `[Unit]` set: a description and nothing else. */
const REVIEWED_BOUNCE_UNIT_KEYS: ReadonlySet<string> = new Set(["Description"]);

/** The closed key set each section of the bounce service is held to. */
const REVIEWED_BOUNCE_KEYS: ReadonlyMap<UnitSection, ReadonlySet<string>> = new Map([
  ["Unit", REVIEWED_BOUNCE_UNIT_KEYS],
  ["Service", REVIEWED_BOUNCE_SERVICE_KEYS],
  ["Install", new Set()],
]);

/**
 * `[Service]` directives pinned to an exact value, each as the only assignment
 * of its key. The two capability directives are pinned to the exact single
 * token `CAP_DAC_OVERRIDE` - the one capability reading the MTA-owned spool
 * needs (see the file header) - so a second token in either directive is a
 * different value and fails the pin: the grant cannot quietly grow.
 */
const requiredBounceServiceValues: ReadonlyArray<readonly [string, string]> = [
  ["CapabilityBoundingSet", "CAP_DAC_OVERRIDE"],
  ["AmbientCapabilities", "CAP_DAC_OVERRIDE"],
  ["ProtectSystem", "strict"],
  ["StateDirectory", "overflow-bounce"],
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
  ["SyslogIdentifier", "overflow-bounce"],
  ["Environment", "PATH=/usr/local/bin:/usr/bin:/bin"],
];

/** `[Service]` directives that must be on, in any spelling systemd reads as true. */
const requiredBounceServiceSwitches: ReadonlyArray<string> = [
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

/** The bounce service's pinned `[Unit]` values. */
const requiredBounceUnitValues: ReadonlyArray<readonly [string, string]> = [
  ["Description", "Report failed deliveries of Overflow alert and canary mail"],
];

/** The keys a test of the bounce service pins a value for, per section. */
function bouncePinnedKeys(section: UnitSection): ReadonlySet<string> {
  if (section === "Service") {
    return new Set([
      ...requiredBounceServiceValues.map(([key]) => key),
      ...requiredBounceServiceSwitches,
      "ExecStart",
    ]);
  }
  if (section === "Unit") {
    return new Set(requiredBounceUnitValues.map(([key]) => key));
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

describe("Overflow bounce service unit", () => {
  let source: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    source = await readFile(resolve("deploy/overflow-bounce.service"));
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
      const reviewed = REVIEWED_BOUNCE_KEYS.get(section)!;
      const pinned = bouncePinnedKeys(section);

      expect([...reviewed].filter((key) => !pinned.has(key))).toEqual([]);
      expect([...pinned].filter((key) => !reviewed.has(key))).toEqual([]);
    },
  );

  it.each(CANONICAL_SECTIONS)(
    "declares no [%s] directive outside the reviewed set",
    (section) => {
      const reviewed = REVIEWED_BOUNCE_KEYS.get(section)!;
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

  it("declares a PATH in Environment= with no /root component", () => {
    const assignment = only("Service", "Environment");

    expect(assignment.value.startsWith("PATH="), "the unit's one Environment= is the PATH").toBe(
      true,
    );
    expect(
      assignment.value.slice("PATH=".length).split(":").filter(isUnderRoot),
    ).toEqual([]);
  });

  it.each(requiredBounceServiceValues)("pins [Service] %s to %s", (key, required) => {
    expectPinnedValue(only("Service", key), required);
  });

  it.each(requiredBounceServiceSwitches)("turns [Service] %s on", (key) => {
    expect(TRUE_SPELLINGS).toContain(only("Service", key).value.toLowerCase());
  });

  it.each(requiredBounceUnitValues)("pins [Unit] %s to %s", (key, required) => {
    expectPinnedValue(only("Unit", key), required);
  });

  it("runs the bounce watcher script through /bin/sh with no arguments", () => {
    expect(only("Service", "ExecStart").words).toEqual([
      "/bin/sh",
      "/srv/overflow/scripts/overflow-bounce.sh",
    ]);
  });

  it("keeps the offset in a state directory, not the canary's runtime directory", () => {
    // The offset must survive reboots, and /run is wiped at boot: the
    // canary's dead-streak marker may be lost at reboot, the bounce offset
    // may not. The absence is pinned, not merely the presence of
    // StateDirectory= - a RuntimeDirectory= alongside it would stand up a
    // second directory the offset could silently migrate into.
    expect(entries().filter((entry) => entry.key.startsWith("RuntimeDirectory"))).toEqual([]);
    expectPinnedValue(only("Service", "StateDirectory"), "overflow-bounce");
  });

  it("grants no write path beyond the state directory the offset needs", () => {
    // /var/mail/mail and the webhook file are read-only to the run; under
    // ProtectSystem=strict the StateDirectory= is added to ReadWritePaths
    // implicitly, so a ReadWritePaths= here would be a hole with no
    // requirement behind it.
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
    [
      "Unit",
      [["Description", "Check every 15 minutes for failed deliveries of Overflow alert and canary mail"]],
    ],
    [
      "Timer",
      [
        ["OnCalendar", "*-*-* *:00/15:00 UTC"],
        ["Persistent", "true"],
        ["Unit", "overflow-bounce.service"],
      ],
    ],
    ["Install", [["WantedBy", "timers.target"]]],
  ]);

describe("Overflow bounce timer unit", () => {
  let source: string = "";

  beforeAll(async () => {
    source = await readFile(resolve("deploy/overflow-bounce.timer"), "utf8");
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
    // Exact spelling, as in the alert and canary guards: the reviewed set
    // admits no key with its value left open, and a value systemd reads
    // differently from the spelling pinned here is a value nobody checked.
    expect(only(section, key).value).toBe(required);
  });

  it("runs quarter-hourly on a fixed UTC schedule", () => {
    const calendar = only("Timer", "OnCalendar").value;

    expect(calendar.endsWith(" UTC"), "a bare wall-clock time moves with the host timezone").toBe(
      true,
    );
    // The quarter-hour grid: minutes 00, 15, 30 and 45 of every hour - 96
    // cheap spool reads a day, which is the whole cost of the watcher.
    expect(calendar).toMatch(/^\*-\*-\* \*:00\/15:00 UTC$/);
  });

  it("triggers the bounce service, so the timer's only effect is that one oneshot", () => {
    expect(only("Timer", "Unit").value).toBe("overflow-bounce.service");
  });
});
