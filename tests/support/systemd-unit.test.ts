import { describe, expect, it } from "vitest";

import { NonCanonicalUnit, isUnderRoot, parseUnitFile } from "./systemd-unit";

/**
 * Every character outside the canonical subset is written as an escape below.
 * A literal one is invisible in a diff and in a review, which is the whole
 * reason the subset refuses it.
 */
const CANONICAL = [
  "# Overflow production web application.",
  "",
  "[Unit]",
  "Description=example",
  "",
  "[Service]",
  "Type=simple",
  "User=overflow",
  "Environment=PATH=/usr/bin",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");

describe("the canonical subset a unit must be written in", () => {
  it("parses the reviewed shapes: headers, assignments, comments and blank lines", () => {
    expect(parseUnitFile(CANONICAL)).toEqual([
      { line: 4, section: "Unit", key: "Description", value: "example", words: ["example"] },
      { line: 7, section: "Service", key: "Type", value: "simple", words: ["simple"] },
      { line: 8, section: "Service", key: "User", value: "overflow", words: ["overflow"] },
      {
        line: 9,
        section: "Service",
        key: "Environment",
        value: "PATH=/usr/bin",
        words: ["PATH=/usr/bin"],
      },
      {
        line: 12,
        section: "Install",
        key: "WantedBy",
        value: "multi-user.target",
        words: ["multi-user.target"],
      },
    ]);
  });

  it("keeps every assignment of a repeated key in file order", () => {
    const parsed = parseUnitFile(
      "[Service]\nCapabilityBoundingSet=\nCapabilityBoundingSet=CAP_SYS_ADMIN\n",
    );

    expect(parsed.map((entry) => entry.value)).toEqual(["", "CAP_SYS_ADMIN"]);
  });

  describe("rule 1: printable ASCII and newline only", () => {
    it.each([
      ["a no-break space appended to a key", "[Service]\nUser\u00a0=overflow\n", "0xa0"],
      ["a no-break space appended to a value", "[Service]\nNoNewPrivileges=yes\u00a0\n", "0xa0"],
      ["a no-break space inside a section header", "[Service\u00a0]\nUser=overflow\n", "0xa0"],
      ["a no-break space before a key", "[Service]\n\u00a0User=overflow\n", "0xa0"],
      ["a vertical tab after a value", "[Service]\nProtectSystem=strict\u000b\n", "0xb"],
      ["a form feed after a value", "[Service]\nProtectHome=yes\u000c\n", "0xc"],
      ["an en space after a value", "[Service]\nPrivateTmp=yes\u2002\n", "0x2002"],
      ["a tab before a key", "[Service]\n\tUser=overflow\n", "0x9"],
      ["a tab inside a section header", "[Service\t]\nUser=overflow\n", "0x9"],
      ["a carriage return at the end of a line", "[Service]\r\nUser=overflow\r\n", "0xd"],
      ["a byte-order mark", "\ufeff[Service]\nUser=overflow\n", "0xfeff"],
      ["an em dash in a comment", "[Service]\n# a note \u2014 aside\nUser=overflow\n", "0x2014"],
      ["an accented letter in a value", "[Service]\nSyslogIdentifier=caf\u00e9\n", "0xe9"],
    ])("refuses %s", (_description, source, byte) => {
      expect(() => parseUnitFile(source)).toThrow(NonCanonicalUnit);
      expect(() => parseUnitFile(source)).toThrow(
        new RegExp(`byte ${byte}\\b.*printable ASCII`),
      );
    });

    it("refuses the raw UTF-8 bytes of a non-ASCII character, not just its code point", () => {
      const bytes = Buffer.from("[Service]\nUser\u00a0=overflow\n", "utf8");

      expect(() => parseUnitFile(bytes)).toThrow(/byte 0xc2\b.*printable ASCII/);
    });

    it("names the line the offending byte is on", () => {
      expect(() => parseUnitFile("[Service]\nType=simple\nUser\u00a0=overflow\n")).toThrow(
        /line 3/,
      );
    });

    it("reads a file given as raw bytes when every byte is canonical", () => {
      expect(parseUnitFile(Buffer.from(CANONICAL, "utf8"))).toEqual(parseUnitFile(CANONICAL));
    });
  });

  describe("rule 2: no line continuations", () => {
    it.each([
      ["a continued assignment", "[Service]\nExecStart=/usr/local/bin/node\\\n  next start\n"],
      ["a continued comment", "[Service]\n# runtime note\\\nUser=root\n"],
      ["a continuation that runs off the end of the file", "[Service]\nUser=overflow\\\n"],
      ["a bare backslash line", "[Service]\n\\\nUser=overflow\n"],
      [
        "a continuation that runs into a section header",
        "[Service]\nUser=overflow\\\n[Install]\nWantedBy=multi-user.target\n",
      ],
    ])("refuses %s", (_description, source) => {
      expect(() => parseUnitFile(source)).toThrow(NonCanonicalUnit);
      expect(() => parseUnitFile(source)).toThrow(/ends in a backslash.*no line continuations/);
    });

    it("refuses a backslash inside a value", () => {
      expect(() => parseUnitFile("[Service]\nSyslogIdentifier=over\\flow x\n")).toThrow(
        /a backslash inside the value of SyslogIdentifier=/,
      );
    });
  });

  describe("rule 3: section headers written exactly", () => {
    it.each([
      ["a trailing space inside the brackets", "[Service ]\nUser=overflow\n"],
      ["a leading space inside the brackets", "[ Service]\nUser=overflow\n"],
      ["a space on both sides inside the brackets", "[ Service ]\nUser=overflow\n"],
      ["a section the unit does not use", "[Socket]\nListenStream=3000\n"],
      ["a lowercase section name", "[service]\nUser=overflow\n"],
      ["an uppercase section name", "[SERVICE]\nUser=overflow\n"],
      ["an X- prefixed section", "[X-Overflow]\nNote=x\n"],
      ["a header with a comment after it", "[Service]# note\nUser=overflow\n"],
    ])("refuses %s", (_description, source) => {
      expect(() => parseUnitFile(source)).toThrow(NonCanonicalUnit);
      expect(() => parseUnitFile(source)).toThrow(
        /not \[Unit\], \[Service\] or \[Install\] written exactly/,
      );
    });

    it("refuses a second header for a section already seen", () => {
      expect(() =>
        parseUnitFile("[Service]\nUser=overflow\n\n[Service]\nProtectSystem=no\n"),
      ).toThrow(/repeats the \[Service\] section header/);
    });

    it("refuses an assignment before the first section header", () => {
      expect(() => parseUnitFile("User=overflow\n[Service]\nType=simple\n")).toThrow(
        /before any section header/,
      );
    });
  });

  describe("rule 4: assignments written exactly", () => {
    it.each([
      ["NoNewPrivileges", "yes"],
      ["ProtectHome", "yes"],
      ["UMask", "0077"],
      ["Environment", "NODE_ENV=production"],
      ["ExecStart", "/usr/local/bin/node start"],
      ["MemoryDenyWriteExecute", "off"],
    ])("refuses leading value whitespace in %s with the spelling to use", (key, value) => {
      expect(() => parseUnitFile(`[Service]\n${key}= ${value}\n`)).toThrow(
        `rule 4 (assignment spacing): line 2 value may not begin with whitespace; ` +
          `write "${key}=${value}" instead of "${key}= ${value}"`,
      );
    });

    it.each([
      ["a space before the equals sign", "[Service]\nUser =overflow\n"],
      ["a key that does not start with a letter", "[Service]\n1User=overflow\n"],
      ["a key carrying a hyphen", "[Service]\nUser-Name=overflow\n"],
      ["a key carrying an underscore", "[Service]\nUser_Name=overflow\n"],
    ])("refuses %s", (_description, source) => {
      expect(() => parseUnitFile(source)).toThrow(NonCanonicalUnit);
      expect(() => parseUnitFile(source)).toThrow(/is not an exact assignment/);
    });

    it.each([
      ["a directive systemd does not unquote", '[Service]\nProtectSystem="strict"\n'],
      ["a directive systemd does unquote", '[Service]\nEnvironment=PATH="/usr/bin"\n'],
      ["an Exec command", "[Service]\nExecStart=/usr/local/bin/node '/srv/next' start\n"],
      ["an unterminated quote", '[Service]\nExecStart=/bin/node "/srv/next\n'],
    ])("refuses a quote in %s", (_description, source) => {
      expect(() => parseUnitFile(source)).toThrow(/a quote in .*=, which the canonical subset/);
    });

    it.each([
      ["EnvironmentFile=%h/overflow.env", "%h"],
      ["WorkingDirectory=%h", "%h"],
      ["ReadWritePaths=/srv/overflow/.next/cache %t/overflow", "%t"],
      ["ExecStart=%S/overflow/next start", "%S"],
      ["Environment=PATH=%h/.nvm/bin:/usr/bin", "%h"],
    ])("refuses %s, whose specifier the guard does not expand", (assignment, specifier) => {
      expect(() => parseUnitFile(`[Service]\n${assignment}\n`)).toThrow(
        `the specifier ${specifier}`,
      );
    });

    it("reads %% as the literal percent systemd expands it to", () => {
      const parsed = parseUnitFile("[Service]\nSyslogIdentifier=100%% overflow\n");

      expect(parsed).toEqual([
        {
          line: 2,
          section: "Service",
          key: "SyslogIdentifier",
          value: "100% overflow",
          words: ["100%", "overflow"],
        },
      ]);
    });

    it("takes the value verbatim, trimming nothing after the equals sign", () => {
      const parsed = parseUnitFile("[Unit]\nDescription=two  spaces  inside\n");

      expect(parsed[0]!.value).toBe("two  spaces  inside");
      expect(parsed[0]!.words).toEqual(["two", "spaces", "inside"]);
    });

    it("reads an empty value as the reset it is", () => {
      const parsed = parseUnitFile("[Service]\nCapabilityBoundingSet=\n");

      expect(parsed).toEqual([
        { line: 2, section: "Service", key: "CapabilityBoundingSet", value: "", words: [] },
      ]);
    });
  });

  describe("rule 5: every line is a header, an assignment, a # comment or empty", () => {
    it.each([
      ["a leading space on an assignment", "[Service]\n User=overflow\n", /begins with a space/],
      ["an indented section header", "[Service]\n  [Install]\n", /begins with a space/],
      ["an indented comment", "[Service]\n  # note\nUser=overflow\n", /begins with a space/],
      ["a trailing space on an assignment", "[Service]\nUser=overflow \n", /ends in a space/],
      ["a trailing space on a section header", "[Service] \nUser=overflow\n", /ends in a space/],
      ["a line of spaces alone", "[Service]\n   \nUser=overflow\n", /begins with a space/],
      [
        "a semicolon comment",
        "[Service]\n; User=root\nUser=overflow\n",
        /neither a section header, an assignment, a "#" comment nor empty/,
      ],
      [
        "a line with no equals sign at all",
        "[Service]\nNoNewPrivileges\n",
        /neither a section header, an assignment, a "#" comment nor empty/,
      ],
      [
        "a drop-in include directive",
        "[Service]\n.include /root/extra.conf\n",
        /neither a section header, an assignment, a "#" comment nor empty/,
      ],
    ])("refuses %s", (_description, source, message) => {
      expect(() => parseUnitFile(source)).toThrow(NonCanonicalUnit);
      expect(() => parseUnitFile(source)).toThrow(message);
    });

    it("drops a comment at column 0 without reading the directive inside it", () => {
      const parsed = parseUnitFile("[Service]\n# ProtectSystem=strict\nUser=overflow\n");

      expect(parsed.map((entry) => entry.key)).toEqual(["User"]);
    });
  });
});

describe("paths a unit value can name", () => {
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
