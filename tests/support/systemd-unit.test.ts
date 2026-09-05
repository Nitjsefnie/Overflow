import { describe, expect, it } from "vitest";

import { UnmodelledUnitShape, isUnderRoot, parseUnitFile } from "./systemd-unit";

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

  it("refuses a continuation whose backslash carries trailing whitespace", () => {
    expect(() =>
      parseUnitFile(
        "[Service]\nSyslogIdentifier=overflow \\\n    production \\   \nUser=root\n",
      ),
    ).toThrow(/trailing whitespace after the backslash/);
  });

  it("refuses trailing whitespace after the backslash on the first line too", () => {
    expect(() =>
      parseUnitFile(
        "[Service]\nRestrictAddressFamilies=AF_INET \\ \n    AF_INET6 AF_UNIX\n",
      ),
    ).toThrow(/trailing whitespace after the backslash/);
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

  it.each([
    ["EnvironmentFile=%h/overflow.env", "%h"],
    ["WorkingDirectory=%h", "%h"],
    ["ReadWritePaths=/srv/overflow/.next/cache %t/overflow", "%t"],
    ["ExecStart=%S/overflow/next start", "%S"],
    ["Environment=PATH=%h/.nvm/bin:/usr/bin", "%h"],
  ])("refuses %s, whose specifier the parser does not expand", (assignment, specifier) => {
    expect(() => parseUnitFile(`[Service]\n${assignment}\n`)).toThrow(
      `the specifier ${specifier}`,
    );
  });

  it("reads %% as the literal percent systemd expands it to", () => {
    const parsed = parseUnitFile("[Service]\nSyslogIdentifier=100%% overflow\n");

    expect(parsed).toEqual([
      {
        section: "Service",
        key: "SyslogIdentifier",
        value: "100% overflow",
        words: ["100%", "overflow"],
      },
    ]);
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
