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
 *
 * `TimeoutStartSec` is here because the script waits on the exim mainlog for a
 * relay verdict, and a run killed at its timeout reports neither outcome - not
 * the delivery, and not the failure it would have reported instead.
 *
 * `SupplementaryGroups` is here because the script READS that log, and the
 * unit's empty capability bounding set means the group is the whole of the
 * permission. The alert template stopped reading only the journal when the
 * script began following a message id into the mainlog to decide whether the
 * alert left the host; this is the directive that keeps that read possible.
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
  "SupplementaryGroups",
  "TimeoutStartSec",
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
  // The script's own ceiling - curl's 30s --max-time plus the 60s it will wait
  // for a relay verdict - is 90s, and this host leaves systemd's
  // DefaultTimeoutStartSec at the same 90s, so without this the run is killed at
  // the moment its own bound expires. Pinned rather than merely reviewed,
  // because the number is the whole point: a shorter timeout reintroduces the
  // silent kill, and a longer one hides a hang.
  ["TimeoutStartSec", "120s"],
  // The script reads /var/log/exim4/mainlog, which is 0640 Debian-exim:adm in a
  // 2750 Debian-exim:adm directory. The unit's empty CapabilityBoundingSet
  // takes away root's CAP_DAC_OVERRIDE, so this group is the only thing that
  // grants the read - measured on this host, the file is unreadable under
  // `capsh --drop=all` and readable under it with this group. Pinned to the one
  // group, so widening it to anything else fails here rather than in
  // production.
  ["SupplementaryGroups", "adm"],
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

/**
 * The alert script's runtime requirements, against the alert unit's sandbox.
 *
 * Nothing else in this repository joins those two. The unit-file suites read
 * `deploy/overflow-alert@.service` as bytes, and the alert script's own suite
 * runs it with a PATH shim and its own scratch log - so a unit that stopped
 * being able to read the log the script now depends on would pass every test
 * here and fail in production, on the one signal the maintainer trusts. The
 * defect that made this necessary was exactly that: the script began reading
 * the exim mainlog, and the unit's empty capability bounding set had quietly
 * stopped allowing it.
 *
 * The binding is textual because it has to run in CI, where /var/log/exim4 does
 * not exist. What is asserted is the relationship, in three parts that each fail
 * if one of the others moves alone: the script's default log path lives under
 * the directory whose group the unit has to grant, the script records which
 * group that is, and the unit grants exactly that group. The file's permissions
 * are a host fact, measured once rather than asserted here: /var/log/exim4 is
 * 2750 Debian-exim:adm and its mainlog is 0640 Debian-exim:adm, so root under
 * an empty CapabilityBoundingSet - no CAP_DAC_OVERRIDE, no CAP_DAC_READ_SEARCH,
 * and not itself a member of adm - is refused the open().
 */
describe("the alert script's read of the exim mainlog, against the alert unit", () => {
  /** The directory the default log path must live under, and whose group matters. */
  const eximLogDirectory = "/var/log/exim4";

  /** The group that owns it, and the one the unit therefore has to grant. */
  const eximLogGroup = "adm";

  let unitSource: Buffer = Buffer.alloc(0);
  let scriptSource = "";

  beforeAll(async () => {
    unitSource = await readFile(resolve("deploy/overflow-alert@.service"));
    scriptSource = await readFile(resolve("scripts/overflow-alert.sh"), "utf8");
  });

  it("defaults to a log under the directory whose group the unit grants", () => {
    const logPath = /exim_log=\$\{OVERFLOW_ALERT_EXIM_LOG:-([^}]+)\}/.exec(scriptSource)?.[1];

    expect(logPath, "the script must name a default exim log path").toBeDefined();
    expect(
      logPath,
      "the default log path has to live under the directory whose group the unit grants",
    ).toMatch(new RegExp(`^${eximLogDirectory}/`));
  });

  it("grants that group, and grants only it", () => {
    const assignments = parseUnitFile(unitSource).filter(
      (entry) => entry.section === "Service" && entry.key === "SupplementaryGroups",
    );

    expect(assignments, "the unit must grant the group the read needs").toHaveLength(1);
    expect(assignments[0]!.value).toBe(eximLogGroup);
  });

  it("is recorded in the script, so the requirement travels with the code that needs it", () => {
    // The script is where the dependency is discovered, by whoever changes the
    // log path next. A comment that does not name the group would leave the
    // next reader to re-derive what a `capsh --drop=all` costs.
    expect(
      scriptSource,
      "the script must record the group its runtime read of the log needs",
    ).toContain(`SupplementaryGroups=${eximLogGroup}`);
  });
});
