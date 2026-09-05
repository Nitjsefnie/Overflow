import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const COMPOSE_FILE = "docker-compose.yml";
const ENVIRONMENT_FILE = ".env.example";
const DATABASE_SERVICE = "postgres";
const DATABASE_CONTAINER_PORT = "5432";
const BIND_VARIABLE = "POSTGRES_HOST_BIND";

// Compose interpolates from an `.env` file in the project directory as well as
// from the process environment, and both CONTRIBUTING.md and README.md tell a
// developer to copy `.env.example` to `.env`. Resolving with nothing set is
// therefore what the documented setup does — but only while that shipped file
// declares nothing, which the "declares no POSTGRES_HOST_BIND" case pins.
const SHIPPED_ENVIRONMENT: Record<string, string> = {};

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
    const mappings = databasePortMappings(await readComposeDocument(), SHIPPED_ENVIRONMENT);

    expect(mappings).not.toHaveLength(0);
    expect(mappings.filter((mapping) => mapping.bindAddress === "").map((mapping) => mapping.source))
      .toEqual([]);
  });

  it("resolves every published database port to loopback under the environment the repository ships", async () => {
    const mappings = databasePortMappings(await readComposeDocument(), SHIPPED_ENVIRONMENT);

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
    const mappings = databasePortMappings(await readComposeDocument(), SHIPPED_ENVIRONMENT);

    expect(mappings).not.toHaveLength(0);
    expect(mappings.filter((mapping) => !coversDatabasePort(mapping.containerPort))
      .map((mapping) => `${mapping.source} -> ${mapping.containerPort}`)).toEqual([]);
  });

  it("keeps the nonproduction credentials on the database service", async () => {
    const document = await readComposeDocument();

    expect(serviceEnvironment(databaseService(document), SHIPPED_ENVIRONMENT)).toMatchObject({
      POSTGRES_DB: "overflow",
      POSTGRES_USER: "overflow",
      POSTGRES_PASSWORD: "overflow_local_only",
    });
  });

  it("declares no service in host network mode, which would bypass the port mapping entirely", async () => {
    const services = composeServices(await readComposeDocument());

    expect(Object.keys(services)).toContain(DATABASE_SERVICE);
    expect(Object.entries(services)
      .filter(([name, service]) => serviceNetworkMode(name, service, SHIPPED_ENVIRONMENT) === "host")
      .map(([name]) => name)).toEqual([]);
  });

  it("binds every mapping touching the database port to loopback, on every service", async () => {
    // Every service the file declares is read, including one `docker compose
    // up` would leave out because a `profiles:` key excludes it from the
    // default profile. That is deliberate rather than an oversight: a profile
    // is selected per invocation, so an excluded service is one flag away from
    // publishing the port, and this suite pins the file rather than one way of
    // running it.
    const services = composeServices(await readComposeDocument());

    expect(Object.keys(services)).toContain(DATABASE_SERVICE);
    expect(Object.entries(services)
      .flatMap(([name, service]) => servicePorts(name, service)
        .map((port) => resolvePortMapping(port, SHIPPED_ENVIRONMENT))
        .filter((mapping) => touchesDatabasePort(mapping) && !isLoopbackAddress(mapping.bindAddress))
        .map((mapping) => `${name}: ${mapping.source} -> ${mapping.bindAddress || "every interface"}`)))
      .toEqual([]);
  });

  it(`declares no ${BIND_VARIABLE} in ${ENVIRONMENT_FILE}, which developers are told to copy to .env`, async () => {
    const contents = await readFile(resolve(ENVIRONMENT_FILE), "utf8");
    const declaration = new RegExp(String.raw`^[ \t]*(?:export[ \t]+)?${BIND_VARIABLE}[ \t]*=.*$`, "m");

    expect(
      contents,
      `${ENVIRONMENT_FILE} no longer looks like the shipped file. It is read here for its own sake: ` +
      `without a line identifying it, an emptied, renamed or moved file would satisfy the absence ` +
      `checked below by carrying nothing at all.`,
    ).toMatch(/^DATABASE_URL=/m);
    expect(declaration.exec(contents)?.[0] ?? null).toBeNull();
  });
});

describe("compose document parsing", () => {
  it("resolves a merge key that puts the database service in host network mode", () => {
    const services = composeServices(parseComposeDocument([
      "x-net: &net",
      "  network_mode: host",
      "services:",
      "  postgres:",
      "    <<: *net",
      "    ports:",
      '      - "127.0.0.1:5432:5432"',
    ].join("\n")));

    expect(services[DATABASE_SERVICE].network_mode).toBe("host");
  });

  it("resolves a merge key that publishes the database port from a second service", () => {
    const services = composeServices(parseComposeDocument([
      "x-wide: &wide",
      "  ports:",
      '    - "0.0.0.0:5432:5432"',
      "services:",
      "  postgres:",
      "    ports:",
      '      - "127.0.0.1:5432:5432"',
      "  pgbouncer:",
      "    <<: *wide",
    ].join("\n")));

    expect(servicePorts("pgbouncer", services.pgbouncer).map((port) => resolvePortMapping(port, {})))
      .toMatchObject([{ bindAddress: "0.0.0.0", hostPort: "5432", containerPort: "5432" }]);
  });

  it("resolves a merge key that supplies the database service's own published ports", () => {
    const document = parseComposeDocument([
      "x-wide: &wide",
      "  ports:",
      '    - "0.0.0.0:5432:5432"',
      "services:",
      "  postgres:",
      "    <<: *wide",
    ].join("\n"));

    expect(databasePortMappings(document, {})).toMatchObject([{ bindAddress: "0.0.0.0" }]);
  });

  it("refuses a top-level include, whose services this suite never reads", () => {
    const document = parseComposeDocument([
      "include:",
      "  - compose-extra.yml",
      "services:",
      "  postgres:",
      "    ports:",
      '      - "127.0.0.1:5432:5432"',
    ].join("\n"));

    expect(() => composeServices(document)).toThrow(/declares a top-level "include"/);
    expect(() => composeServices(document)).toThrow(/Model "include" in this test/);
  });

  it("refuses extends on a service, whose inherited keys this suite never reads", () => {
    const document = parseComposeDocument([
      "services:",
      "  postgres:",
      "    extends:",
      "      file: compose-extra.yml",
      "      service: wide",
      "    ports:",
      '      - "127.0.0.1:5432:5432"',
    ].join("\n"));

    expect(() => composeServices(document)).toThrow(/declares "extends" on the service "postgres"/);
    expect(() => composeServices(document)).toThrow(/write the inherited keys out on "postgres"/);
  });

  it("resolves an interpolated network_mode, which Compose substitutes before honouring it", () => {
    const services = composeServices(parseComposeDocument([
      "services:",
      "  postgres:",
      '    network_mode: "${NETMODE:-host}"',
      "    ports:",
      '      - "127.0.0.1:5432:5432"',
    ].join("\n")));

    expect(serviceNetworkMode("postgres", services.postgres, {})).toBe("host");
  });

  it("resolves an interpolated credential value, which Compose substitutes before the container reads it", () => {
    const document = parseComposeDocument([
      "services:",
      "  postgres:",
      "    environment:",
      '      POSTGRES_PASSWORD: "${PGPW:-overflow_local_only}"',
      "    ports:",
      '      - "127.0.0.1:5432:5432"',
    ].join("\n"));

    expect(serviceEnvironment(composeServices(document).postgres, {}))
      .toMatchObject({ POSTGRES_PASSWORD: "overflow_local_only" });
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
    // Every accepted spelling below was taken by `docker create -p
    // <ip>:15499:80`; `localhost` and `0177.0.0.1` were refused by it with
    // "Invalid ip address", so treating them as loopback would be a fiction.
    expect(["127.0.0.1", "127.0.0.2", "::1"].map(isLoopbackAddress)).toEqual([true, true, true]);
    expect(["::ffff:127.0.0.1", "0:0:0:0:0:0:0:1", "[::ffff:127.0.0.1]", "[0:0:0:0:0:0:0:1]"]
      .map(isLoopbackAddress)).toEqual([true, true, true, true]);
    expect(["0.0.0.0", "::", "192.168.1.10", ""].map(isLoopbackAddress))
      .toEqual([false, false, false, false]);
    expect(["localhost", "0177.0.0.1", "::ffff:0.0.0.0", "0:0:0:0:0:0:0:0"].map(isLoopbackAddress))
      .toEqual([false, false, false, false]);
  });

  it("counts a port range as covering the database port", () => {
    expect(["5432", "5430-5440"].map(coversDatabasePort)).toEqual([true, true]);
    expect(["5433", "15432", "5433-5440", ""].map(coversDatabasePort))
      .toEqual([false, false, false, false]);
  });

  it("counts a mapping as touching the database port on either side of the mapping", () => {
    const mapping = (hostPort: string, containerPort: string): PortMapping =>
      ({ source: `${hostPort}:${containerPort}`, bindAddress: "", hostPort, containerPort });

    expect(touchesDatabasePort(mapping("5432", "6432"))).toBe(true);
    expect(touchesDatabasePort(mapping("6432", "5432"))).toBe(true);
    expect(touchesDatabasePort(mapping("5430-5440", "6432"))).toBe(true);
    expect(touchesDatabasePort(mapping("6432", "6432"))).toBe(false);
    expect(touchesDatabasePort(mapping("", "6432"))).toBe(false);
  });

  it("names the service when docker-compose.yml does not declare the database service", () => {
    expect(() => databaseService({ services: { database: {} } }))
      .toThrow(/no "postgres" service.*database/s);
    expect(() => databaseService({ version: "3.9" })).toThrow(/services/);
  });

  it("reports a database service that publishes nothing as read, without diagnosing why", () => {
    const unpublished = () => databasePortMappings({ services: { postgres: {} } }, {});

    expect(unpublished).toThrow(/declares no published port/);
    // Whether the database is reachable is not something a port list answers —
    // a service in host network mode reaches it with no mapping at all — so the
    // message states what was read rather than what it would imply.
    expect(unpublished).not.toThrow(/cannot reach the database/);
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

  it("refuses a nested interpolation instead of substituting only its outer half", () => {
    // The diagnosis has to quote the expression as written: one naming only the
    // fragment the supported-form pattern consumed would blame a value
    // docker-compose.yml never wrote.
    expect(() => interpolate("${A:-${B:-z}}", {})).toThrow(/unsupported/i);
    expect(() => interpolate("${A:-${B:-z}}", {})).toThrow(/\$\{A:-\$\{B:-z\}\}/);
    expect(() => interpolate("${A-$B}", {})).toThrow(/unsupported/i);
  });
});

async function readComposeDocument(): Promise<unknown> {
  return parseComposeDocument(await readFile(resolve(COMPOSE_FILE), "utf8"));
}

// Compose resolves YAML merge keys, so a service can receive `ports:`,
// `network_mode:` or anything else this file reads from an anchor instead of
// writing it out. The `yaml` package does not resolve them unless asked, and
// without this option such a service is invisible to every assertion above
// while Compose still publishes it.
function parseComposeDocument(text: string): unknown {
  return parse(text, { merge: true });
}

// `include` and `extends` each let Compose resolve a service definition that is
// not written here: `include` merges another Compose file's services into the
// project, and `extends` merges one service into another, from a second file
// when it names one. Neither is modelled, and this suite's contract is that an
// unmodelled construct is a named diagnosis rather than a key walked past, so
// both are refused where the services are collected.
function composeServices(document: unknown): Record<string, ComposeService> {
  if (isRecord(document) && document.include !== undefined) {
    throw new Error(
      `${COMPOSE_FILE} declares a top-level "include", which merges another Compose file's services into ` +
      `this project. This suite reads only ${COMPOSE_FILE}, so an included service could publish the ` +
      `database on every interface with every assertion here green. Model "include" in this test, or write ` +
      `the included services out here.`,
    );
  }
  if (!isRecord(document) || !isRecord(document.services)) {
    throw new Error(`${COMPOSE_FILE} declares no "services" mapping to inspect.`);
  }
  const services: Record<string, ComposeService> = {};
  for (const [name, service] of Object.entries(document.services)) {
    if (!isRecord(service)) {
      throw new Error(`${COMPOSE_FILE} declares the service "${name}" as something other than a mapping.`);
    }
    if (service.extends !== undefined) {
      throw new Error(
        `${COMPOSE_FILE} declares "extends" on the service "${name}", which merges another service ` +
        `definition into it, from another file when it names one. This suite reads only the keys written on ` +
        `the service itself, so the inherited definition could publish the database on every interface with ` +
        `every assertion here green. Model "extends" in this test, or write the inherited keys out on ` +
        `"${name}".`,
      );
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

// Compose interpolates an environment value as it does a port entry, so a
// credential written as "${PGPW:-overflow_local_only}" is the shipped password.
// Comparing the raw scalar would report a difference Compose does not make.
function serviceEnvironment(
  service: ComposeService,
  environment: Record<string, string>,
): Record<string, unknown> {
  if (!isRecord(service.environment)) {
    throw new Error(`${COMPOSE_FILE} declares no "environment" mapping on the "${DATABASE_SERVICE}" service.`);
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(service.environment)) {
    resolved[key] = typeof value === "string" ? interpolate(value, environment) : value;
  }
  return resolved;
}

// `network_mode` is interpolated too, and a service in host network mode reaches
// the host's interfaces with no port mapping at all, so reading the raw scalar
// would let "${NETMODE:-host}" through the assertion that refuses "host".
function serviceNetworkMode(
  name: string,
  service: ComposeService,
  environment: Record<string, string>,
): string {
  const mode = service.network_mode;
  if (mode === undefined) return "";
  if (typeof mode !== "string" && typeof mode !== "number") {
    throw new Error(
      `${COMPOSE_FILE} declares "network_mode" on the service "${name}" as something other than a scalar.`,
    );
  }
  return interpolate(String(mode), environment);
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
      `${COMPOSE_FILE} declares no published port on the "${DATABASE_SERVICE}" service, ` +
      `so there is no bind address for this suite to pin. Publish the port under "ports:".`,
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

// Docker accepts a bind address in any of these spellings; `localhost` and
// octal forms such as `0177.0.0.1` it rejects outright, so this classifier has
// no reason to understand them.
const LOOPBACK_ADDRESSES = [
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i,
  /^::1$/,
  /^(?:0{1,4}:){7}0{0,3}1$/,
];

function isLoopbackAddress(address: string): boolean {
  const bare = stripBrackets(address);
  return LOOPBACK_ADDRESSES.some((spelling) => spelling.test(bare));
}

// A port entry is either a single port or a range, on either side of a mapping.
function coversDatabasePort(port: string): boolean {
  const range = /^(\d+)-(\d+)$/.exec(port);
  if (range === null) return port === DATABASE_CONTAINER_PORT;
  return Number(range[1]) <= Number(DATABASE_CONTAINER_PORT)
    && Number(DATABASE_CONTAINER_PORT) <= Number(range[2]);
}

// Which side of a mapping the database port sits on says nothing about who can
// reach it: a sibling published as "0.0.0.0:5432:6432" puts the database port on
// every interface just as surely as one published as "0.0.0.0:6432:5432".
function touchesDatabasePort(mapping: PortMapping): boolean {
  return coversDatabasePort(mapping.hostPort) || coversDatabasePort(mapping.containerPort);
}

const SUPPORTED_INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)-([^}]*))?\}/g;

// A default holding a further "$" is a nested expression such as
// "${A:-${B:-z}}". The supported form above would consume "${A:-${B:-z}" — its
// default stops at the first "}" — and leave a bare "}" that carries no "$" for
// the guard below to refuse, so the nested form is named here first.
const NESTED_INTERPOLATION = /\$\{[A-Za-z_][A-Za-z0-9_]*:?-[^}]*\$/;

// Mirrors Compose variable interpolation for the `${VAR}`, `${VAR-default}` and
// `${VAR:-default}` forms, so the file's own default can be read without a
// container runtime. Every other use of `$` is refused by name: leaving it
// unsubstituted would make this test's verdict depend on an expression it never
// evaluated.
function interpolate(value: string, environment: Record<string, string>): string {
  if (NESTED_INTERPOLATION.test(value)) {
    throw new Error(
      `unsupported nested Compose interpolation in ${JSON.stringify(value)}: ` +
      'this test models only ${VAR}, ${VAR-default} and ${VAR:-default}, whose defaults hold no further "$".',
    );
  }
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
