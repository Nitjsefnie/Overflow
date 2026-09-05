import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

type UnitEntry = {
  section: string;
  key: string;
  /** The assignment as written, after continuation joining and trimming. */
  value: string;
  /** The value split into words, with quotes removed where systemd removes them. */
  words: string[];
};

/**
 * A shape of systemd's configuration grammar this guard does not model.
 *
 * The guard reads the unit without systemd, so it can only defend the shapes it
 * models. Guessing at the rest is how a directive hides: a backslash-terminated
 * comment reads as "commented out" to a naive parser while systemd applies the
 * line beneath it. Anything unmodelled is refused instead, so an unrecognised
 * shape fails the suite rather than passing it silently.
 */
class UnmodelledUnitShape extends Error {
  constructor(description: string) {
    super(`the guard does not model ${description}; systemd may read it differently`);
    this.name = "UnmodelledUnitShape";
  }
}

/**
 * Drops comments and joins backslash continuations, in that order.
 *
 * systemd.syntax(7): comment lines are ignored, and "lines ending in a
 * backslash are concatenated with the following line while reading and the
 * backslash is replaced by a space character". Comments are removed *before*
 * joining, so a comment that ends in a backslash does not swallow the directive
 * under it — that shape is refused rather than joined.
 */
function toLogicalLines(source: string): string[] {
  const logicalLines: string[] = [];
  let carried: string | null = null;

  for (const physicalLine of source.split(/\r?\n/)) {
    const trimmed = physicalLine.trim();
    const isComment = trimmed.startsWith("#") || trimmed.startsWith(";");

    if (isComment) {
      if (trimmed.endsWith("\\")) {
        throw new UnmodelledUnitShape("a comment line that ends in a backslash");
      }
      if (carried !== null) {
        throw new UnmodelledUnitShape("a comment line inside a continuation");
      }
      continue;
    }

    if (carried !== null) {
      if (/^\[.*\]$/.test(trimmed)) {
        throw new UnmodelledUnitShape("a continuation that runs into a section header");
      }
      if (trimmed === "") {
        throw new UnmodelledUnitShape("a continuation broken by a blank line");
      }
    }

    const line: string = carried === null ? physicalLine : `${carried} ${trimmed}`;

    if (line.endsWith("\\")) {
      carried = line.slice(0, -1).trimEnd();
      continue;
    }

    carried = null;
    logicalLines.push(line);
  }

  if (carried !== null) {
    throw new UnmodelledUnitShape("a continuation that runs off the end of the file");
  }

  return logicalLines;
}

/**
 * The `[Service]` directives whose values systemd unquotes, verified against
 * systemd 257.13 with `systemd-analyze verify`: quoting is per-directive, not
 * global. `ExecStart=`, `Environment=`, `ReadWritePaths=`,
 * `RestrictAddressFamilies=`, `CapabilityBoundingSet=` and
 * `AmbientCapabilities=` all accept a quoted value and strip the quotes, while
 * `ProtectSystem="strict"`, `NoNewPrivileges="yes"`, `ProcSubset="pid"`,
 * `UMask="0077"`, `SystemCallFilter="@system-service"`, `WorkingDirectory=` and
 * `EnvironmentFile=` all fail to parse and are *ignored* — leaving the property
 * unset. A quote anywhere else is therefore refused rather than stripped.
 */
const UNQUOTING_KEYS: ReadonlySet<string> = new Set([
  "Environment",
  "ReadWritePaths",
  "RestrictAddressFamilies",
  "CapabilityBoundingSet",
  "AmbientCapabilities",
]);

function unquotesItsValue(key: string): boolean {
  return key.startsWith("Exec") || UNQUOTING_KEYS.has(key);
}

/** Splits a value into words the way the directive's own parser would. */
function toWords(key: string, value: string): string[] {
  if (value.includes("\\")) {
    throw new UnmodelledUnitShape(`a backslash inside the value of ${key}=`);
  }

  if (!unquotesItsValue(key)) {
    if (/["']/.test(value)) {
      throw new UnmodelledUnitShape(`a quote in ${key}=, which systemd does not unquote`);
    }
    return value.split(/\s+/).filter((word) => word !== "");
  }

  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;

  for (const character of value) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += character;
    started = true;
  }

  if (quote !== null) {
    throw new UnmodelledUnitShape(`an unterminated ${quote} quote in ${key}=`);
  }
  if (started) {
    words.push(current);
  }

  return words;
}

/**
 * Parses a systemd unit into its assignments. Comments are dropped, keys are
 * scoped to their section, and every assignment of a repeated key is kept in
 * file order, so a directive reset and then widened further down does not read
 * as the hardened one. Every value is split at parse time, so a shape the guard
 * cannot classify fails the whole file rather than one assertion.
 */
function parseUnitFile(source: string): UnitEntry[] {
  const entries: UnitEntry[] = [];
  let section = "";

  for (const logicalLine of toLogicalLines(source)) {
    const line = logicalLine.trim();

    if (line === "") {
      continue;
    }

    const sectionHeader = /^\[(.+)\]$/.exec(line);
    if (sectionHeader) {
      section = sectionHeader[1]!.trim();
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      throw new UnmodelledUnitShape(`a line that is neither a section header nor an assignment: ${line}`);
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    entries.push({ section, key, value, words: toWords(key, value) });
  }

  return entries;
}

/**
 * Whether a path names `/root` or something inside it, once the path is
 * resolved the way the kernel resolves it: repeated separators collapse and
 * `..` segments are removed, and the comparison lands on a segment boundary so
 * `/rootless` is not a match.
 *
 * systemd's own prefixes come off first. A `-` in front of a path makes it
 * optional (`EnvironmentFile=-/root/overflow.env` is a live reference to
 * `/root`, accepted by `systemd-analyze verify`), and a command line may carry
 * `-@+!:`. A raw prefix test reads all of those as "not a path at all".
 */
function isUnderRoot(candidate: string): boolean {
  const unprefixed = candidate.replace(/^[-@+!:]+/, "");

  if (!unprefixed.startsWith("/")) {
    return false;
  }

  const normalized = posix.normalize(unprefixed.replace(/^\/+/, "/"));
  const path = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;

  return path === "/root" || path.startsWith("/root/");
}

/** The path-shaped pieces of a value: words, split again on PATH colons and `NAME=value`. */
function pathCandidates(entry: UnitEntry): string[] {
  return entry.words
    .flatMap((word) => word.split(/[:=]+/))
    .filter((candidate) => candidate !== "");
}

/**
 * systemd's boolean spellings, verified against systemd 257.13: `PrivateTmp=YES`,
 * `RestrictSUIDSGID=t` and `ProtectHome=y` all parse, so the match is
 * case-insensitive and covers the short forms too.
 */
const TRUE_SPELLINGS: ReadonlySet<string> = new Set(["1", "y", "yes", "t", "true", "on"]);
const FALSE_SPELLINGS: ReadonlySet<string> = new Set(["0", "n", "no", "f", "false", "off"]);

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
      { section: "Unit", key: "Description", value: "example", words: ["example"] },
      { section: "Service", key: "User", value: "overflow", words: ["overflow"] },
      {
        section: "Service",
        key: "Environment",
        value: "PATH=/usr/bin",
        words: ["PATH=/usr/bin"],
      },
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
        words: ["/usr/local/bin/node", "/srv/overflow/next", "start"],
      },
    ]);
  });

  it("refuses a comment line that ends in a backslash", () => {
    expect(() =>
      parseUnitFile("[Service]\n# runtime note \\\nUser=root\n"),
    ).toThrow(UnmodelledUnitShape);
  });

  it("refuses a comment line inside a continuation", () => {
    expect(() =>
      parseUnitFile("[Service]\nRestrictAddressFamilies=AF_INET \\\n# note\nAF_UNIX\n"),
    ).toThrow(UnmodelledUnitShape);
  });

  it("refuses a continuation that runs off the end of the file", () => {
    expect(() => parseUnitFile("[Service]\nUser=overflow \\\n")).toThrow(
      UnmodelledUnitShape,
    );
  });

  it("refuses a continuation that runs into another section", () => {
    expect(() =>
      parseUnitFile("[Service]\nUser=overflow \\\n[Install]\nWantedBy=multi-user.target\n"),
    ).toThrow(UnmodelledUnitShape);
  });

  it("refuses a continuation broken by a blank line", () => {
    expect(() => parseUnitFile("[Service]\nUser=overflow \\\n\nGroup=overflow\n")).toThrow(
      UnmodelledUnitShape,
    );
  });

  it("refuses an unterminated quote", () => {
    expect(() => parseUnitFile('[Service]\nExecStart=/bin/node "/srv/next\n')).toThrow(
      UnmodelledUnitShape,
    );
  });

  it("refuses a backslash inside a value", () => {
    expect(() => parseUnitFile("[Service]\nSyslogIdentifier=over\\flow x\n")).toThrow(
      UnmodelledUnitShape,
    );
  });

  it("refuses a quote in a directive systemd does not unquote", () => {
    expect(() => parseUnitFile('[Service]\nProtectSystem="strict"\n')).toThrow(
      UnmodelledUnitShape,
    );
  });

  it("strips quotes from the directives systemd unquotes", () => {
    const parsed = parseUnitFile(
      [
        "[Service]",
        'Environment=PATH="/root/nvm/bin:/usr/bin"',
        `ExecStart=/usr/local/bin/node '/root/evil/next' start`,
      ].join("\n"),
    );

    expect(parsed.map((entry) => entry.words)).toEqual([
      ["PATH=/root/nvm/bin:/usr/bin"],
      ["/usr/local/bin/node", "/root/evil/next", "start"],
    ]);
  });

  it.each([
    ["/root", true],
    ["/root/overflow", true],
    ["//root/overflow", true],
    ["/srv/../root/overflow", true],
    ["/root/../srv/overflow", false],
    ["-/root/overflow.env", true],
    ["+/root/evil", true],
    ["/rootless/overflow", false],
    ["/srv/overflow", false],
    ["-/srv/overflow", false],
    ["-R", false],
  ])("resolves %s before testing it against /root", (candidate, expected) => {
    expect(isUnderRoot(candidate)).toBe(expected);
  });
});

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
