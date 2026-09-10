import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const COMPOSE_FILE = "docker-compose.yml";
const ENVIRONMENT_FILE = ".env.example";
const DATABASE_SERVICE = "postgres";
const DATABASE_PORT = 5432;
const BIND_VARIABLE = "POSTGRES_HOST_BIND";
const NONPRODUCTION_CREDENTIALS = {
  POSTGRES_DB: "overflow",
  POSTGRES_USER: "overflow",
  POSTGRES_PASSWORD: "overflow_local_only",
};

// The suite reads the exposure contract off `docker compose config`, so the
// resolved document is produced once and shared by every case below. All of
// them fail — none skip — when Docker or the Compose plugin is missing: a
// security pin that silently stops checking is worse than one that fails
// loudly, and CI (ubuntu-latest) ships the plugin.
let resolvedDocument: Promise<ResolvedDocument> | undefined;

function resolvedComposeDocument(): Promise<ResolvedDocument> {
  resolvedDocument ??= resolveComposeDocument();
  return resolvedDocument;
}

async function resolveComposeDocument(): Promise<ResolvedDocument> {
  // Interpolation must not see anything from the invoking shell: a developer
  // exporting POSTGRES_HOST_BIND, COMPOSE_* or DOCKER_* variables must not
  // change this suite's verdict. The invocation gets only what Docker needs to
  // find its binary and CLI plugins, and an empty env file so a project `.env`
  // (which the documented setup creates from `.env.example`) cannot widen the
  // resolution either — the shipped file is pinned as shipped.
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const name of ["PATH", "HOME", "DOCKER_CONFIG"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const directory = await mkdtemp(resolve(tmpdir(), "compose-exposure-"));
  try {
    // Compose reads this file instead of any project `.env`, so the
    // resolution depends on nothing but docker-compose.yml itself.
    const emptyEnvironmentFile = resolve(directory, "empty.env");
    await writeFile(emptyEnvironmentFile, "");
    const stdout = await new Promise<string>((resolvePromise, reject) => {
      execFile(
        "docker",
        [
          "compose",
          "-f",
          resolve(COMPOSE_FILE),
          "--env-file",
          emptyEnvironmentFile,
          "config",
          "--format",
          "json",
        ],
        { env: environment },
        (error, stdout, stderr) => {
          // Warnings go to stderr and are not failures: the gate is the exit
          // status, surfaced here as a non-null error.
          if (error !== null) {
            error.message = diagnoseComposeFailure(error, stderr);
            reject(error);
            return;
          }
          resolvePromise(stdout);
        },
      );
    });
    return JSON.parse(stdout) as ResolvedDocument;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function diagnoseComposeFailure(error: Error, stderr: string): string {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return 'docker was not found on PATH. This suite reads the database exposure contract off "docker compose config" instead of re-implementing Compose resolution, so the docker CLI must be installed; install Docker Engine and re-run this suite.';
  }
  if (stderr.includes("'compose' is not a docker command") || stderr.includes("unknown shorthand flag: 'f' in -f")) {
    return "the Docker Compose plugin is missing: docker parsed the command but has no compose subcommand ('unknown shorthand flag: 'f' in -f', or 'compose' is not a docker command). Install the Compose v2 plugin (on Debian/Ubuntu: apt install docker-compose-plugin; otherwise https://docs.docker.com/compose/install/) and re-run this suite.";
  }
  return `docker compose config failed (${error.message.split("\n")[0]}); stderr: ${stderr.trim()}`;
}

describe("local development database exposure", () => {
  // `docker compose config` resolves only the services selected by profile, so
  // a service excluded from the default profile is invisible to every
  // assertion here while `docker compose --profile <name> up` would still
  // publish it. This suite reads the raw file's service names — names only,
  // nothing else is read from the raw YAML — and refuses the gap rather than
  // covering it silently.
  it("resolves every service the file declares", async () => {
    const declared = declaredServiceNames(await readFile(resolve(COMPOSE_FILE), "utf8"));
    const resolved = Object.keys((await resolvedComposeDocument()).services ?? {});
    expect(
      declared.filter((name) => !resolved.includes(name)),
      'Compose resolved fewer services than the file declares. A "profiles:" key hides a service from `docker compose config`, so the assertions below do not cover it while `docker compose --profile <name> up` would still publish it. Write the service into the default profile, or extend this suite to resolve with that profile.',
    ).toEqual([]);
  });

  it("puts no service on the host network, which would bypass port publishing entirely", async () => {
    const resolved = await resolvedComposeDocument();
    expect(
      Object.entries(resolved.services ?? {})
        .filter(([, service]) => service.network_mode === "host")
        .map(([name]) => name),
    ).toEqual([]);
  });

  it("binds every published port touching the database port to loopback, on every service", async () => {
    const resolved = await resolvedComposeDocument();
    const findings: string[] = [];
    for (const [name, service] of Object.entries(resolved.services ?? {})) {
      for (const entry of service.ports ?? []) {
        if (!isPublishedDatabaseFacing(entry)) continue;
        // An absent host_ip publishes on every interface; that is the default
        // Compose resolves to, so it is read as the exposure it is.
        const hostIp = entry.host_ip;
        if (hostIp === undefined || hostIp === "") {
          findings.push(`${name}: ${JSON.stringify(entry)} binds every interface (no host_ip)`);
        } else if (!isLoopbackAddress(hostIp)) {
          findings.push(`${name}: ${JSON.stringify(entry)} binds ${hostIp}, which is not loopback`);
        }
      }
    }
    // The shipped database must actually publish the port: otherwise every
    // filter above runs over nothing and the pin is vacuously green.
    const databaseEntries = (resolved.services?.[DATABASE_SERVICE]?.ports ?? [])
      .filter((entry) => isPublishedDatabaseFacing(entry));
    expect(
      databaseEntries,
      `${COMPOSE_FILE} publishes no ${DATABASE_PORT} port on the "${DATABASE_SERVICE}" service, so there is nothing for this suite to pin.`,
    ).not.toHaveLength(0);
    expect(findings).toEqual([]);
  });

  it("keeps the nonproduction credentials on the database service", async () => {
    const resolved = await resolvedComposeDocument();
    expect(resolved.services?.[DATABASE_SERVICE]?.environment).toMatchObject(NONPRODUCTION_CREDENTIALS);
  });

  // Both CONTRIBUTING.md and README.md tell a developer to copy
  // `.env.example` to `.env`, so this file is the shipped environment
  // contract. It is read for its own sake — without a line identifying it, an
  // emptied, renamed or moved file would satisfy the absence checked below by
  // carrying nothing at all.
  it(`declares no ${BIND_VARIABLE} in ${ENVIRONMENT_FILE}, which developers are told to copy to .env`, async () => {
    const contents = await readFile(resolve(ENVIRONMENT_FILE), "utf8");
    const declaration = new RegExp(String.raw`^[ \t]*(?:export[ \t]+)?${BIND_VARIABLE}[ \t]*=.*$`, "m");

    expect(
      contents,
      `${ENVIRONMENT_FILE} no longer looks like the shipped file.`,
    ).toMatch(/^DATABASE_URL=/m);
    expect(declaration.exec(contents)?.[0] ?? null).toBeNull();
  });
});

// An entry is published only when it carries a "published" port; a bare
// long-form target is expose-only and reachable from no interface at all.
// Which side of a mapping the database port sits on says nothing about who can
// reach it: a sibling published as 0.0.0.0:5432:6432 puts the database port on
// every interface just as surely as one published as 0.0.0.0:6432:5432.
function isPublishedDatabaseFacing(entry: ResolvedPort): boolean {
  if (entry.published === undefined || entry.published === null || entry.published === "") return false;
  const target = entry.target === undefined || entry.target === null ? "" : String(entry.target);
  return portCovers(String(entry.published), DATABASE_PORT) || portCovers(target, DATABASE_PORT);
}

// A port is either a single number or a range; Number() reads "05432" as
// decimal 5432, which is how the daemon parses it too.
function portCovers(spec: string, port: number): boolean {
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range === null) return Number(spec) === port;
  return Number(range[1]) <= port && port <= Number(range[2]);
}

// Docker accepts loopback in any of these spellings; `localhost` and octal
// forms such as `0177.0.0.1` it rejects outright, so the classifier has no
// reason to understand them. Compose's resolved output carries the address as
// written, so every spelling Compose accepts must classify correctly here.
function isLoopbackAddress(address: string): boolean {
  let ip = address;
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const lower = ip.toLowerCase();
  if (net.isIPv4(ip)) {
    const octets = ip.split(".");
    return octets.length === 4 && octets[0] === "127";
  }
  if (net.isIPv6(lower)) {
    const expanded = expandIpv6(lower);
    if (expanded === null) return false;
    if (expanded === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
    // An IPv4-mapped IPv6 address (::ffff:0:0/96) is loopback exactly when the
    // mapped IPv4 address is: ::ffff:7f00:1 is ::ffff:127.0.0.1.
    return /^0000:0000:0000:0000:0000:ffff:7f/.test(expanded);
  }
  return false;
}

function expandIpv6(address: string): string | null {
  const parts = address.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] === "" ? [] : parts[0].split(":");
  const tail = parts.length === 2 ? (parts[1] === "" ? [] : parts[1].split(":")) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const expanded: string[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    expanded.push(group.padStart(4, "0"));
  }
  return expanded.join(":");
}

function declaredServiceNames(contents: string): string[] {
  const document = parse(contents) as { services?: unknown };
  if (document === null || typeof document !== "object" || document.services === undefined) {
    throw new Error(`${COMPOSE_FILE} declares no "services" mapping to inspect.`);
  }
  if (document.services === null || typeof document.services !== "object") {
    throw new Error(`${COMPOSE_FILE} declares "services" as something other than a mapping.`);
  }
  return Object.keys(document.services);
}

type ResolvedPort = {
  host_ip?: string;
  published?: string | number;
  target?: number | string;
};

type ResolvedService = {
  network_mode?: string;
  ports?: ResolvedPort[];
  environment?: Record<string, string>;
};

type ResolvedDocument = {
  services?: Record<string, ResolvedService>;
};
