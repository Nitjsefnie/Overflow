import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const COMPOSE_FILE = "docker-compose.yml";
const ENVIRONMENT_FILE = ".env.example";
const DATABASE_SERVICE = "postgres";
const DATABASE_CONTAINER_PORT = "5432";
const BIND_VARIABLE = "POSTGRES_HOST_BIND";

// A Compose service is read as an untyped mapping and narrowed field by field,
// so a shape this test does not model is reported as a diagnosis instead of
// surfacing as a TypeError from inside a helper.
type ComposeService = Record<string, unknown>;

type PortMapping = {
  // The entry as written, for failure messages.
  source: string;
  // Empty when the entry leaves the bind address to Compose, which publishes
  // the port on every interface.
  bindAddress: string;
  // Empty when the entry leaves the host port to Compose.
  hostPort: string;
  containerPort: string;
};

describe("local development database exposure", () => {
  it("declares an explicit host bind address on every published database port", async () => {
    const [document, shipped] = await readRepositoryConfiguration();
    const mappings = databasePortMappings(document, shipped);

    expect(mappings).not.toHaveLength(0);
    expect(mappings.filter((mapping) => mapping.bindAddress === "").map((mapping) => mapping.source))
      .toEqual([]);
  });

  it("resolves every published database port to loopback under the environment the repository ships", async () => {
    const [document, shipped] = await readRepositoryConfiguration();
    const mappings = databasePortMappings(document, shipped);

    expect(mappings).not.toHaveLength(0);
    expect(mappings.filter((mapping) => !isLoopbackAddress(mapping.bindAddress))
      .map((mapping) => `${mapping.source} -> ${mapping.bindAddress}`)).toEqual([]);
  });

  it(`widens the bind address only where a mapping asks for ${BIND_VARIABLE}, and stays loopback when it is empty`, async () => {
    const document = await readComposeDocument();
    const requested = "203.0.113.10";
    const widened = databasePortMappings(document, { [BIND_VARIABLE]: requested });
    const emptied = databasePortMappings(document, { [BIND_VARIABLE]: "" });

    expect(widened).not.toHaveLength(0);
    expect(widened
      .filter((mapping) => mapping.bindAddress !== requested && !isLoopbackAddress(mapping.bindAddress))
      .map((mapping) => `${mapping.source} -> ${mapping.bindAddress}`)).toEqual([]);
    expect(emptied.filter((mapping) => !isLoopbackAddress(mapping.bindAddress))
      .map((mapping) => `${mapping.source} -> ${mapping.bindAddress}`)).toEqual([]);
  });

  it("publishes the database on the standard container port", async () => {
    const [document, shipped] = await readRepositoryConfiguration();
    const mappings = databasePortMappings(document, shipped);

    expect(mappings).not.toHaveLength(0);
    expect(mappings.filter((mapping) => mapping.containerPort !== DATABASE_CONTAINER_PORT)
      .map((mapping) => `${mapping.source} -> ${mapping.containerPort}`)).toEqual([]);
  });

  it("keeps the nonproduction credentials on the database service", async () => {
    const document = await readComposeDocument();

    expect(serviceEnvironment(databaseService(document))).toMatchObject({
      POSTGRES_DB: "overflow",
      POSTGRES_USER: "overflow",
      POSTGRES_PASSWORD: "overflow_local_only",
    });
  });

  it("declares no service in host network mode, which would bypass the port mapping entirely", async () => {
    const services = composeServices(await readComposeDocument());

    expect(Object.keys(services)).toContain(DATABASE_SERVICE);
    expect(Object.entries(services)
      .filter(([, service]) => service.network_mode === "host")
      .map(([name]) => name)).toEqual([]);
  });

  it("publishes the database port from no service other than the database service", async () => {
    const [document, shipped] = await readRepositoryConfiguration();
    const services = composeServices(document);

    expect(Object.keys(services)).toContain(DATABASE_SERVICE);
    expect(Object.entries(services)
      .filter(([name]) => name !== DATABASE_SERVICE)
      .flatMap(([name, service]) => servicePorts(name, service)
        .map((port) => resolvePortMapping(port, shipped))
        .filter((mapping) => coversDatabasePort(mapping.containerPort))
        .map((mapping) => `${name}: ${mapping.source}`))).toEqual([]);
  });

  it(`ships no widened ${BIND_VARIABLE} in ${ENVIRONMENT_FILE}, which developers are told to copy to .env`, async () => {
    const shipped = await readShippedEnvironment();

    expect(shipped).toHaveProperty("DATABASE_URL");
    // Absent is the shipped state: Compose then applies the loopback default
    // that the cases above pin.
    expect(isLoopbackAddress(shipped[BIND_VARIABLE] ?? "127.0.0.1")).toBe(true);
  });
});

describe("compose port resolution", () => {
  it("reads the bind address, host port and container port out of every supported form", () => {
    const environment = {};
    expect(resolvePortMapping("${POSTGRES_HOST_BIND:-127.0.0.1}:5432:5432", environment))
      .toMatchObject({ bindAddress: "127.0.0.1", hostPort: "5432", containerPort: "5432" });
    expect(resolvePortMapping("${POSTGRES_HOST_BIND:-[::1]}:5432:5432", environment))
      .toMatchObject({ bindAddress: "::1", hostPort: "5432", containerPort: "5432" });
    expect(resolvePortMapping("127.0.0.1:15432:5432", environment))
      .toMatchObject({ bindAddress: "127.0.0.1", hostPort: "15432", containerPort: "5432" });
    expect(resolvePortMapping("127.0.0.1::5432", environment))
      .toMatchObject({ bindAddress: "127.0.0.1", hostPort: "", containerPort: "5432" });
    expect(resolvePortMapping("127.0.0.1:5432:5432/tcp", environment))
      .toMatchObject({ bindAddress: "127.0.0.1", hostPort: "5432", containerPort: "5432" });
    expect(resolvePortMapping("5432:5432", environment))
      .toMatchObject({ bindAddress: "", hostPort: "5432", containerPort: "5432" });
    expect(resolvePortMapping("5432", environment))
      .toMatchObject({ bindAddress: "", hostPort: "", containerPort: "5432" });
    expect(resolvePortMapping(5432, environment))
      .toMatchObject({ bindAddress: "", hostPort: "", containerPort: "5432" });
  });

  it("reads the long form, where an absent host_ip means every interface", () => {
    expect(resolvePortMapping({ host_ip: "127.0.0.1", published: 5432, target: 5432 }, {}))
      .toMatchObject({ bindAddress: "127.0.0.1", hostPort: "5432", containerPort: "5432" });
    expect(resolvePortMapping({ host_ip: "${POSTGRES_HOST_BIND:-::1}", target: 5432 }, {}))
      .toMatchObject({ bindAddress: "::1", hostPort: "", containerPort: "5432" });
    expect(resolvePortMapping({ published: "5432", target: 5432 }, {}))
      .toMatchObject({ bindAddress: "", hostPort: "5432", containerPort: "5432" });
  });

  it("diagnoses a port entry it cannot model instead of throwing from inside a helper", () => {
    expect(() => resolvePortMapping("1:2:3:4", {})).toThrow(/docker-compose\.yml/);
    expect(() => resolvePortMapping("[::1:5432:5432", {})).toThrow(/docker-compose\.yml/);
    expect(() => resolvePortMapping({ published: 5432 }, {})).toThrow(/target/);
    expect(() => resolvePortMapping(true, {})).toThrow(/docker-compose\.yml/);
  });

  it("treats only loopback addresses as loopback", () => {
    expect(["127.0.0.1", "127.0.0.2", "::1"].map(isLoopbackAddress)).toEqual([true, true, true]);
    expect(["0.0.0.0", "::", "192.168.1.10", ""].map(isLoopbackAddress))
      .toEqual([false, false, false, false]);
  });

  it("counts a container-side port range as publishing the database port", () => {
    expect(["5432", "5430-5440"].map(coversDatabasePort)).toEqual([true, true]);
    expect(["5433", "15432", "5433-5440", ""].map(coversDatabasePort))
      .toEqual([false, false, false, false]);
  });

  it("names the service when docker-compose.yml does not declare the database service", () => {
    expect(() => databaseService({ services: { database: {} } }))
      .toThrow(/no "postgres" service.*database/s);
    expect(() => databaseService({ version: "3.9" })).toThrow(/services/);
  });

  it("reports a database service that publishes nothing", () => {
    expect(() => databasePortMappings({ services: { postgres: {} } }, {}))
      .toThrow(/publishes no port/);
  });
});

describe("dotenv parsing", () => {
  it("reads the assignments Compose would read from an env file", () => {
    expect(parseEnvironmentFile([
      "# a comment",
      "",
      "PLAIN=value",
      "export EXPORTED=value",
      'QUOTED="quoted value"',
      "WITH_EQUALS=postgresql://user:pass@host/db?a=b",
    ].join("\n"))).toEqual({
      PLAIN: "value",
      EXPORTED: "value",
      QUOTED: "quoted value",
      WITH_EQUALS: "postgresql://user:pass@host/db?a=b",
    });
  });

  it("refuses a line it cannot model rather than silently dropping it", () => {
    expect(() => parseEnvironmentFile("POSTGRES_HOST_BIND 0.0.0.0")).toThrow(/POSTGRES_HOST_BIND 0\.0\.0\.0/);
  });
});

describe("compose variable interpolation", () => {
  const cases: Array<{ template: string; environment: Record<string, string>; expected: string }> = [
    { template: "${VAR}", environment: { VAR: "set" }, expected: "set" },
    { template: "${VAR}", environment: {}, expected: "" },
    { template: "${VAR}", environment: { VAR: "" }, expected: "" },
    { template: "${VAR-fallback}", environment: { VAR: "set" }, expected: "set" },
    { template: "${VAR-fallback}", environment: {}, expected: "fallback" },
    { template: "${VAR-fallback}", environment: { VAR: "" }, expected: "" },
    { template: "${VAR:-fallback}", environment: { VAR: "set" }, expected: "set" },
    { template: "${VAR:-fallback}", environment: {}, expected: "fallback" },
    { template: "${VAR:-fallback}", environment: { VAR: "" }, expected: "fallback" },
    { template: "${VAR:-}", environment: {}, expected: "" },
    { template: "before-${VAR:-mid}-after", environment: {}, expected: "before-mid-after" },
    { template: "${A:-1}:${B:-2}", environment: { B: "9" }, expected: "1:9" },
    { template: "no substitution here", environment: { VAR: "set" }, expected: "no substitution here" },
  ];

  for (const { template, environment, expected } of cases) {
    it(`resolves ${JSON.stringify(template)} with ${JSON.stringify(environment)} to ${JSON.stringify(expected)}`, () => {
      expect(interpolate(template, environment)).toBe(expected);
    });
  }

  const unsupported = ["$VAR", "${VAR:?required}", "${VAR?required}", "${VAR:+alt}", "${VAR+alt}", "$$", "${}"];

  for (const template of unsupported) {
    it(`refuses the unsupported form ${JSON.stringify(template)} instead of leaving it unsubstituted`, () => {
      expect(() => interpolate(template, { VAR: "set" })).toThrow(/unsupported/i);
    });
  }
});

async function readRepositoryConfiguration(): Promise<[unknown, Record<string, string>]> {
  return Promise.all([readComposeDocument(), readShippedEnvironment()]);
}

async function readComposeDocument(): Promise<unknown> {
  return parse(await readFile(resolve(COMPOSE_FILE), "utf8"));
}

// Compose interpolates from an `.env` file in the project directory as well as
// from the process environment, and both CONTRIBUTING.md and README.md tell a
// developer to copy `.env.example` to `.env`, so this is what "unset" means to
// somebody following the documented setup.
async function readShippedEnvironment(): Promise<Record<string, string>> {
  return parseEnvironmentFile(await readFile(resolve(ENVIRONMENT_FILE), "utf8"));
}

function composeServices(document: unknown): Record<string, ComposeService> {
  if (!isRecord(document) || !isRecord(document.services)) {
    throw new Error(`${COMPOSE_FILE} declares no "services" mapping to inspect.`);
  }
  const services: Record<string, ComposeService> = {};
  for (const [name, service] of Object.entries(document.services)) {
    if (!isRecord(service)) {
      throw new Error(`${COMPOSE_FILE} declares the service "${name}" as something other than a mapping.`);
    }
    services[name] = service;
  }
  return services;
}

function databaseService(document: unknown): ComposeService {
  const services = composeServices(document);
  const service = services[DATABASE_SERVICE];
  if (service === undefined) {
    const declared = Object.keys(services).map((name) => JSON.stringify(name)).join(", ");
    throw new Error(
      `${COMPOSE_FILE} declares no "${DATABASE_SERVICE}" service; it declares ${declared || "nothing"}. ` +
      `If the database service was renamed deliberately, rename DATABASE_SERVICE in this test with it.`,
    );
  }
  return service;
}

function serviceEnvironment(service: ComposeService): Record<string, unknown> {
  if (!isRecord(service.environment)) {
    throw new Error(`${COMPOSE_FILE} declares no "environment" mapping on the "${DATABASE_SERVICE}" service.`);
  }
  return service.environment;
}

function servicePorts(name: string, service: ComposeService): unknown[] {
  if (service.ports === undefined) return [];
  if (!Array.isArray(service.ports)) {
    throw new Error(`${COMPOSE_FILE} declares "ports" on the service "${name}" as something other than a list.`);
  }
  return service.ports;
}

function databasePortMappings(document: unknown, environment: Record<string, string>): PortMapping[] {
  const service = databaseService(document);
  const mappings = servicePorts(DATABASE_SERVICE, service)
    .map((port) => resolvePortMapping(port, environment));
  if (mappings.length === 0) {
    throw new Error(
      `${COMPOSE_FILE} publishes no port from the "${DATABASE_SERVICE}" service, ` +
      `so the documented local setup cannot reach the database at all.`,
    );
  }
  return mappings;
}

function resolvePortMapping(port: unknown, environment: Record<string, string>): PortMapping {
  if (typeof port === "string" || typeof port === "number") {
    return resolveShortPortMapping(String(port), environment);
  }
  if (isRecord(port)) return resolveLongPortMapping(port, environment);
  throw new Error(
    `${COMPOSE_FILE} declares the port entry ${JSON.stringify(port)}, which is neither a string nor a mapping.`,
  );
}

// The short syntax is `[HOST_IP:[HOST_PORT]:]CONTAINER_PORT[/PROTOCOL]`, where a
// literal IPv6 host is bracketed and therefore cannot be split on ":".
function resolveShortPortMapping(port: string, environment: Record<string, string>): PortMapping {
  const spec = interpolate(port, environment);
  const protocol = spec.indexOf("/");
  let remainder = protocol === -1 ? spec : spec.slice(0, protocol);
  let bindAddress = "";
  if (remainder.startsWith("[")) {
    const close = remainder.indexOf("]");
    if (close === -1 || remainder[close + 1] !== ":") {
      throw new Error(
        `${COMPOSE_FILE} declares the port "${port}", which resolves to "${spec}": ` +
        `its bracketed IPv6 bind address is not closed by "]:".`,
      );
    }
    bindAddress = remainder.slice(1, close);
    remainder = remainder.slice(close + 2);
  }
  const segments = remainder.split(":");
  if (bindAddress === "" && segments.length === 3) bindAddress = segments.shift() ?? "";
  if (segments.length > 2) {
    throw new Error(
      `${COMPOSE_FILE} declares the port "${port}", which resolves to "${spec}": ` +
      `more colon-separated fields than [HOST_IP:[HOST_PORT]:]CONTAINER_PORT allows.`,
    );
  }
  const containerPort = segments[segments.length - 1];
  if (containerPort === "") {
    throw new Error(`${COMPOSE_FILE} declares the port "${port}", which resolves to "${spec}" with no container port.`);
  }
  return {
    source: port,
    bindAddress: stripBrackets(bindAddress),
    hostPort: segments.length === 2 ? segments[0] : "",
    containerPort,
  };
}

// The long syntax names the same fields explicitly. An absent `host_ip` is
// Compose's every-interface default, so it stays empty here rather than
// defaulting to loopback.
function resolveLongPortMapping(port: Record<string, unknown>, environment: Record<string, string>): PortMapping {
  const source = JSON.stringify(port);
  if (port.target === undefined) {
    throw new Error(`${COMPOSE_FILE} declares the long-form port ${source} without a "target" container port.`);
  }
  return {
    source,
    bindAddress: stripBrackets(longPortField(port, "host_ip", source, environment)),
    hostPort: longPortField(port, "published", source, environment),
    containerPort: longPortField(port, "target", source, environment),
  };
}

function longPortField(
  port: Record<string, unknown>,
  field: string,
  source: string,
  environment: Record<string, string>,
): string {
  const value = port[field];
  if (value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${COMPOSE_FILE} declares the long-form port ${source} with a non-scalar "${field}".`);
  }
  return interpolate(String(value), environment);
}

function stripBrackets(address: string): string {
  return address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
}

function isLoopbackAddress(address: string): boolean {
  const bare = stripBrackets(address);
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) || bare === "::1";
}

function coversDatabasePort(containerPort: string): boolean {
  const range = /^(\d+)-(\d+)$/.exec(containerPort);
  if (range === null) return containerPort === DATABASE_CONTAINER_PORT;
  return Number(range[1]) <= Number(DATABASE_CONTAINER_PORT)
    && Number(DATABASE_CONTAINER_PORT) <= Number(range[2]);
}

function parseEnvironmentFile(contents: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (assignment === null) {
      throw new Error(
        `${ENVIRONMENT_FILE} carries the line ${JSON.stringify(trimmed)}, ` +
        `which is neither a comment nor a NAME=value assignment.`,
      );
    }
    environment[assignment[1]] = unquote(assignment[2]);
  }
  return environment;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted === null ? value : quoted[2];
}

const SUPPORTED_INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)-([^}]*))?\}/g;

// Mirrors Compose variable interpolation for the `${VAR}`, `${VAR-default}` and
// `${VAR:-default}` forms, so the file's own default can be read without a
// container runtime. Every other use of `$` is refused by name: leaving it
// unsubstituted would make this test's verdict depend on an expression it never
// evaluated.
function interpolate(value: string, environment: Record<string, string>): string {
  const unsupported = /\$(?:\{[^}]*\}?|[^\s:/]*)/.exec(value.replace(SUPPORTED_INTERPOLATION, ""));
  if (unsupported !== null) {
    throw new Error(
      `unsupported Compose interpolation ${JSON.stringify(unsupported[0])} in ${JSON.stringify(value)}: ` +
      "this test models only ${VAR}, ${VAR-default} and ${VAR:-default}.",
    );
  }
  return value.replace(
    SUPPORTED_INTERPOLATION,
    (_match, name: string, colon: string | undefined, fallback: string | undefined) => {
      const current = environment[name];
      if (fallback === undefined) return current ?? "";
      if (current === undefined) return fallback;
      return colon === ":" && current === "" ? fallback : current;
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
