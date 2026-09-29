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
 * Every `[Service]` directive `deploy/overflow-alert@.service` is reviewed to
 * carry, closed the same way `tests/deploy/unit-file.test.ts` closes the web
 * unit's set: a directive that is not here fails the suite, so `mail`,
 * `ReadWritePaths=` or `ProcSubset=` cannot creep back in without a human
 * putting them here first.
 *
 * `mail` and `ProcSubset=` each have a measured reason to stay out. The unit
 * submits mail by SMTP to the local exim daemon with curl, because invoking
 * exim in-process needs the setgroups() privilege dance that the empty
 * capability bounding set deliberately removes; and journalctl reads
 * /proc/sys/kernel/random/boot_id, which `ProcSubset=pid` hides. The unit
 * writes exactly one thing — the alert script's throttle state under
 * /run/overflow-alert, which `RuntimeDirectory=` grants implicitly — so there
 * is still no `ReadWritePaths=`: the exim daemon spools the submission outside
 * this sandbox.
 */
const REVIEWED_ALERT_SERVICE_KEYS: ReadonlySet<string> = new Set([
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

/** The alert template's `[Unit]` set: a description and nothing else. */
const REVIEWED_ALERT_UNIT_KEYS: ReadonlySet<string> = new Set(["Description"]);

/** The closed key set each section of the alert template is held to. */
const REVIEWED_ALERT_KEYS: ReadonlyMap<UnitSection, ReadonlySet<string>> = new Map([
  ["Unit", REVIEWED_ALERT_UNIT_KEYS],
  ["Service", REVIEWED_ALERT_SERVICE_KEYS],
  ["Install", new Set()],
]);

/** `[Service]` directives pinned to an exact value, each as the only assignment of its key. */
const requiredAlertServiceValues: ReadonlyArray<readonly [string, string]> = [
  ["CapabilityBoundingSet", ""],
  ["AmbientCapabilities", ""],
  ["ProtectSystem", "strict"],
  ["RuntimeDirectory", "overflow-alert"],
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
  ["SyslogIdentifier", "overflow-alert"],
  ["Environment", "PATH=/usr/local/bin:/usr/bin:/bin"],
];

/** `[Service]` directives that must be on, in any spelling systemd reads as true. */
const requiredAlertServiceSwitches: ReadonlyArray<string> = [
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

/** The alert template's pinned `[Unit]` values. */
const requiredAlertUnitValues: ReadonlyArray<readonly [string, string]> = [
  ["Description", "Email the failure log of %i"],
];

/** The keys a test of the alert template pins a value for, per section. */
function alertPinnedKeys(section: UnitSection): ReadonlySet<string> {
  if (section === "Service") {
    return new Set([
      ...requiredAlertServiceValues.map(([key]) => key),
      ...requiredAlertServiceSwitches,
      "ExecStart",
    ]);
  }
  if (section === "Unit") {
    return new Set(requiredAlertUnitValues.map(([key]) => key));
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

describe("Overflow alert template unit", () => {
  let source: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    source = await readFile(resolve("deploy/overflow-alert@.service"));
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
      const reviewed = REVIEWED_ALERT_KEYS.get(section)!;
      const pinned = alertPinnedKeys(section);

      expect([...reviewed].filter((key) => !pinned.has(key))).toEqual([]);
      expect([...pinned].filter((key) => !reviewed.has(key))).toEqual([]);
    },
  );

  it.each(CANONICAL_SECTIONS)(
    "declares no [%s] directive outside the reviewed set",
    (section) => {
      const reviewed = REVIEWED_ALERT_KEYS.get(section)!;
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

  it("declares no [Install] section, because an OnFailure-triggered unit is never enabled", () => {
    expect(entries().filter((entry) => entry.section === "Install")).toEqual([]);
  });

  it("keeps every path-valued directive out of /root", () => {
    const offending = entries()
      .filter((entry) => pathCandidates(entry).some(isUnderRoot))
      .map((entry) => `${entry.key}=${entry.value}`);

    expect(offending).toEqual([]);
  });

  it.each(requiredAlertServiceValues)("pins [Service] %s to %s", (key, required) => {
    expectPinnedValue(only("Service", key), required);
  });

  it.each(requiredAlertServiceSwitches)("turns [Service] %s on", (key) => {
    expect(TRUE_SPELLINGS).toContain(only("Service", key).value.toLowerCase());
  });

  it.each(requiredAlertUnitValues)("pins [Unit] %s to %s", (key, required) => {
    expectPinnedValue(only("Unit", key), required);
  });

  it("runs the alert script through /bin/sh with the failed unit as the only argument", () => {
    expect(only("Service", "ExecStart").words).toEqual([
      "/bin/sh",
      "/srv/overflow/scripts/overflow-alert.sh",
      "%i",
    ]);
  });
});

describe("Overflow backup unit failure wiring", () => {
  let source: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    source = await readFile(resolve("deploy/overflow-backup.service"));
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

  it("pages the alert template with this unit's name when it fails", () => {
    expectPinnedValue(only("Unit", "OnFailure"), "overflow-alert@%n.service");
  });

  it("stays a oneshot, whose nonzero exit is the failure OnFailure reacts to", () => {
    expectPinnedValue(only("Service", "Type"), "oneshot");
  });
});
