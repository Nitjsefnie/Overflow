#!/usr/bin/env node
/**
 * CI-enforced layout-regression check: measure reader-visible page geometry in
 * a real browser against the pages a real build serves (issue 111).
 *
 * Why this exists: jsdom does no layout. The component suite renders markup and
 * stylesheets but never computes geometry, so a stylesheet edit can push the
 * landing page's sign-in button below the fold with the whole suite green —
 * eleven such mutants were measured while fixing the earlier landing-page
 * issue. This check is the class-level cover:
 *
 *   - a page's primary control moved below the fold,
 *   - an element cut off horizontally,
 *   - the page overflowing sideways.
 *
 * What it deliberately does NOT do: no computed-style or stylesheet-term
 * enumeration (asserting `margin-top: 1.5rem` fails in both directions — it
 * blocks a faithful restyle and misses a different rule with the same effect),
 * and no prose or markup pinning (a test matching page copy fails on a reword
 * and passes when the sentence moves). Reader-visible geometric relations only.
 *
 * Run (after pnpm build):
 *
 *   node scripts/check-page-geometry.mjs
 *
 * or against an already-running server:
 *
 *   node scripts/check-page-geometry.mjs --base-url http://127.0.0.1:3000
 *
 * No new npm dependencies: the script drives Chrome over the DevTools protocol
 * with Node's built-in WebSocket, and starts/stops its own `next start` server.
 * The session fixture (issue 453) mints its JWT with node:crypto and seeds its
 * users through the `postgres` client the app itself already depends on.
 */

import { spawn } from "node:child_process";
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

const USAGE = `usage: node scripts/check-page-geometry.mjs [--base-url URL] [--help]

Measures the page contracts below in headless Chrome against a real production
build (pnpm build first), asserting per page and viewport: the contract
selector matches, the stylesheet is actually applied, the primary action is
visible, fully above the fold and inside the horizontal bounds, and the page
does not overflow sideways. Exits 1 on any failure.

  --base-url URL   measure against an already-running server instead of
                   spawning one from .next on 127.0.0.1:3219
  --help           this text

A spawned server (no --base-url) needs DATABASE_URL, from the environment or
the repo-root .env file (the only env file this check loads); the run refuses
to launch anything without it.

Chrome is discovered from LAYOUT_CHECK_CHROME, then google-chrome-stable,
google-chrome, chromium, chromium-browser (PATH and /usr/bin).
LAYOUT_CHECK_PORT overrides the spawned server's port (default 3219).
`;

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

/** A flag's value, failing cleanly when the flag is present but valueless. */
function flaggedValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} needs a value\n\n${USAGE}`);
    process.exit(2);
  }
  return value;
}

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * The port the spawned measurement server binds, overridable so concurrent
 * runs on one machine need not squat each other's port (issue 514: three
 * simultaneous sightings in one night). Mirrors the LAYOUT_CHECK_CHROME
 * discovery override. Unset or empty keeps the default; anything that is
 * not a plain decimal integer from 1 to 65535 is refused, naming the
 * variable and the offending value. The value is validated at startup
 * regardless of mode — only the SPAWNED server consults it, but an invalid
 * one refuses the run before anything starts, whichever mode.
 */
export function parseLayoutCheckPort(value) {
  if (value === undefined || value === "") return 3219;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`LAYOUT_CHECK_PORT must be a whole number from 1 to 65535, got "${value}"`);
  }
  return Number(value);
}

/** flaggedValue's failure shape — the message, the USAGE, exit 2. */
function parseLayoutCheckPortOrExit(value) {
  try {
    return parseLayoutCheckPort(value);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
}

const PORT = parseLayoutCheckPortOrExit(process.env.LAYOUT_CHECK_PORT);
const BASE_URL = (flaggedValue("--base-url") ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");

/**
 * The environment a spawned `next start` needs, verified BEFORE anything is
 * launched (issue 471): the production server cannot render any page without
 * a database, and a missing one used to surface only after the spawn as
 * "page did not render (HTTP 500)", which reads as a layout regression.
 * Empty string counts as missing — the server cannot connect with it either.
 */
const REQUIRED_ENV = ["DATABASE_URL"];

/**
 * Next.js loads repo-root .env files at server startup, so a developer whose
 * DATABASE_URL lives only in one of these has a working flow today; its
 * presence satisfies the preflight even when the variable is absent from the
 * environment. Exactly the production set Next.js loads (issue 471).
 */
const ENV_FILE_NAMES = [".env", ".env.local", ".env.production", ".env.production.local"];

/** Whether any repo-root .env file Next.js would load exists. */
function repoEnvFileExists() {
  return ENV_FILE_NAMES.some((name) => existsSync(join(repoRoot, name)));
}

/**
 * Load the repo-root `.env` into the run's environment, the way the
 * preflight's remedy and USAGE advertise and the spawned server experiences
 * them. The server loads the .env family itself at startup — but the run's
 * seeding and secret reads happen in THIS process, so without this a
 * preflight-passing .env-only run threw "DATABASE_URL is not set" from the
 * very variable the preflight had just declared satisfied (issue 453 round
 * 4; the db:migrate --env-file-if-exists contract is the precedent, and its
 * tests/scripts/db-migrate-env-file.test.ts the pin shape).
 *
 * Semantics: `.env` at the repo root only; a missing file is a no-op; an
 * already-exported variable wins over the file value (an empty exported
 * value counts as exported). Returns the names this load filled.
 */
export async function loadRepoEnvFile({ repoRoot: root = repoRoot, env = process.env, readFileFn = readFile } = {}) {
  const text = await readFileFn(join(root, ".env"), "utf8").catch(() => null);
  if (text === null) return [];

  const applied = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const withoutExportPrefix = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const equals = withoutExportPrefix.indexOf("=");
    if (equals <= 0) continue;
    const key = withoutExportPrefix.slice(0, equals).trim();
    let value = withoutExportPrefix.slice(equals + 1).trim();
    // Both real consumers of this format — node's --env-file and the
    // installed @next/env — strip an unquoted `#` comment unconditionally
    // (not only after whitespace), and keep a `#` inside quotes. Matching
    // them is load-bearing: a DATABASE_URL whose password carries `#` must
    // parse the same for the seeding read as for the server it renders
    // against (reviewer differential, round-4 polish).
    const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : undefined;
    if (quote !== undefined && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const commentStart = value.indexOf("#");
      if (commentStart !== -1) value = value.slice(0, commentStart).trim();
    }
    if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

/**
 * The required names this run's environment leaves unsatisfied: a name is
 * missing when it is absent or empty from `env` AND no repo-root .env file
 * would supply it at server startup. `env` defaults to process.env and the
 * .env-file check is injectable so both branches are unit-testable without a
 * real repo root, the way the launch tests drive launchChromeWithRetry with
 * a fake spawn. Exported for those tests; the script calls it on the spawn
 * path only — with --base-url the target server's environment is not this
 * process's business (issue 471).
 */
export function missingRequiredEnv(env = process.env, envFileExists = repoEnvFileExists) {
  return REQUIRED_ENV.filter((name) => {
    const value = env[name];
    if (value !== undefined && value !== "") return false;
    return !envFileExists();
  });
}

/**
 * The refusal message for a run whose required environment is unsatisfied,
 * composed from the missing names (issue 471). The remedy names the
 * repo-root .env file EXACTLY — the only env file this check's own process
 * loads (loadRepoEnvFile above) — not the wider Next.js family the spawned
 * server reads: a developer following the printed remedy with the variable
 * solely in .env.local would otherwise self-contradict mid-run (round-4
 * polish). Extracted so a test can pin the message's content — both
 * remedies and the variable name — against the same composition the script
 * prints, the way a mutant that drops a remedy cannot slip past the suite.
 */
export function missingEnvMessage(missing) {
  return (
    `${missing.join(", ")} is not set — the spawned server cannot render any page without it. ` +
    `Set it in the environment, or write it to the repo-root .env file ` +
    `(the only env file this check loads), then rerun.`
  );
}

/**
 * The session fixture (issue 453): the reusable pieces a signed-in contract
 * needs. Seeding creates two fixed-ID users; minting produces the session
 * cookie value the server accepts for one of them; delivery is CDP's
 * Network.setCookie in the contract loop below. Later geometry cases inherit
 * the whole mechanism by adding a contract row with `authAs`.
 */

/**
 * The NextAuth session cookie name on a non-secure origin. BASE_URL is always
 * http://127.0.0.1, so `useSecureCookies` is false and the name carries no
 * `__Secure-` prefix (installed @auth/core `defaultCookies(false)`). It is
 * also the hkdf salt: the app's session decode passes the cookie NAME as the
 * salt (installed @auth/core `lib/actions/session.js`: `salt =
 * options.cookies.sessionToken.name`).
 */
export const SESSION_COOKIE_NAME = "authjs.session-token";

/** One hour of token life — a gate run lasts minutes; freshness is cheap. */
const SESSION_TOKEN_MAX_AGE_SECONDS = 3600;

/**
 * The fixture users, by fixed IDs so repeated seeding is an upsert and later
 * runs find the same rows. The github ids/logins are namespaced to this
 * fixture; should a real user ever own them, the insert fails loudly on the
 * unique constraint rather than silently reusing that account.
 */
const FIXTURE_USERS = [
  { id: "00000000-0000-4000-8000-00000000453a", githubUserId: 945300453, login: "geometry-fixture-member", role: "MEMBER" },
  { id: "00000000-0000-4000-8000-00000000453b", githubUserId: 945300454, login: "geometry-fixture-moderator", role: "MODERATOR" },
];

/**
 * The contract table's `authAs` values, total: an unknown value throws naming
 * the contract instead of silently signing in as one of the real roles.
 */
const AUTH_AS_ROLES = { member: "MEMBER", moderator: "MODERATOR" };

/**
 * Idempotently create the fixture users in whatever database `databaseUrl`
 * names — the gate's DATABASE_URL, a scratch container in CI or --base-url
 * mode alike. Never deletes or demotes anything else; the only columns the
 * conflict path rewrites are `role` (back to the fixture contract) and
 * `updated_at`. Every other NOT NULL column of `users` has a default
 * (db/migrations/001_initial.sql). Opens its own client and closes it.
 */
export async function seedFixtureUsers({ databaseUrl }) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [member, moderator] = FIXTURE_USERS;
    const seeded = await sql`
      insert into users (id, github_user_id, github_login, role)
      values
        (${member.id}, ${member.githubUserId}, ${member.login}, ${member.role}),
        (${moderator.id}, ${moderator.githubUserId}, ${moderator.login}, ${moderator.role})
      on conflict (id) do update set role = excluded.role, updated_at = now()
      returning id, role
    `;

    const roleById = new Map(seeded.map((row) => [row.id, row.role]));
    for (const fixture of FIXTURE_USERS) {
      if (roleById.get(fixture.id) !== fixture.role) {
        throw new Error(
          `geometry fixture user ${fixture.id} did not seed as ${fixture.role} ` +
            `(row reads ${String(roleById.get(fixture.id))})`,
        );
      }
    }

    return { memberUserId: member.id, moderatorUserId: moderator.id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The JWK thumbprint of the derived key, the `kid` jwt.js writes into the
 * protected header: the SHA-512 digest (a 64-byte key -> "sha512") of the
 * RFC 7638 canonical `{"k","kty"}` JSON, base64url-encoded. Matches the
 * installed jose `calculateJwkThumbprint` for an "oct" key byte for byte.
 */
function derivedKeyThumbprint(cek) {
  return createHash("sha512")
    .update(`{"k":"${cek.toString("base64url")}","kty":"oct"}`, "utf8")
    .digest("base64url");
}

/**
 * Mint a NextAuth session JWT exactly as the installed @auth/core 0.41.3
 * writes the session cookie — derived from the installed
 * `node_modules/@auth/core/jwt.js` and its jose 6.2.11 dependency, not from
 * memory, and pinned by the interop test in
 * tests/scripts/check-page-geometry-session.test.ts. The plan's first-pass
 * sketch differed from the installed code in three ways; the installed code
 * wins everywhere:
 *
 *   - hkdf info is NOT empty: `Auth.js Generated Encryption Key (<salt>)`,
 *     output 64 bytes for A256CBC-HS512 (jwt.js getDerivedEncryptionKey).
 *   - The token is a dir + A256CBC-HS512 JWE with a `kid` thumbprint header,
 *     not a CompactEncrypt/A256GCM token (jwt.js `alg`/`enc` and
 *     `setProtectedHeader`).
 *   - jti is `crypto.randomUUID()` (jwt.js `setJti`).
 *
 * A256CBC-HS512 is an RFC 7518 §5.2 CBC-HMAC cipher: the 64-byte CEK splits
 * into a MAC key (first half) and an AES key (second half); the tag is the
 * HMAC-SHA-512 of AAD || IV || ciphertext || uint64be(AAD length in bits),
 * truncated to 32 bytes. AAD is the ASCII of the base64url protected header,
 * and WebCrypto's AES-CBC pads like node's `aes-256-cbc` (PKCS#7) — the byte
 * shapes copied from the installed jose `content_encryption.js` and
 * `jwe_encrypt.js`. `now` is injectable so tests can mint deterministically;
 * an expired token must fail the server-side decode, which is its own test.
 */
export function mintSessionCookieValue({ secret, userId, role, now = Date.now() }) {
  const issuedAtSeconds = Math.floor((now instanceof Date ? now.getTime() : now) / 1000);

  const salt = SESSION_COOKIE_NAME;
  const cek = Buffer.from(hkdfSync("sha256", secret, salt, `Auth.js Generated Encryption Key (${salt})`, 64));

  const protectedHeader = Buffer.from(
    JSON.stringify({ alg: "dir", enc: "A256CBC-HS512", kid: derivedKeyThumbprint(cek) }),
    "utf8",
  ).toString("base64url");

  const payload = JSON.stringify({
    sub: userId,
    userId,
    role,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + SESSION_TOKEN_MAX_AGE_SECONDS,
    jti: randomUUID(),
  });

  const iv = randomBytes(16);
  const macKey = cek.subarray(0, 32);
  const encKey = cek.subarray(32);
  const cipher = createCipheriv("aes-256-cbc", encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);

  const aad = Buffer.from(protectedHeader, "ascii");
  const aadBits = Buffer.alloc(8);
  aadBits.writeBigUInt64BE(BigInt(aad.length * 8));
  const macData = Buffer.concat([aad, iv, ciphertext, aadBits]);
  const tag = createHmac("sha512", macKey).update(macData).digest().subarray(0, 32);

  // Compact serialization; the second member (encrypted key) is empty for
  // `dir` (jose joins protected, encrypted_key, iv, ciphertext, tag with ".").
  return [protectedHeader, "", iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

/**
 * The AUTH_SECRET the session cookie is minted with — the target server
 * derives its decryption key from the same value, so only an exact match is
 * accepted. Required on the first authed contract only; a run with no authed
 * contracts never asks for it. The refusal names CONTRIBUTING (issue 555):
 * its check list is where the requirement is written down, and a repro that
 * followed that list alone had nothing else to learn the variable from.
 * Exported so a test can pin the message's content — the variable name, the
 * pointer and the emptiness contract — the way missingEnvMessage is pinned.
 */
export function fixtureAuthSecret() {
  const secret = process.env.AUTH_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error(
      "AUTH_SECRET is not set — a signed-in contract cannot get a session cookie the server accepts. " +
        "Set it to the same secret the target server was started with. " +
        "CONTRIBUTING.md's check list names this requirement.",
    );
  }
  return secret;
}

/**
 * Deliver the session cookie on the page's flat DevTools session. The Network
 * domain must be enabled on the session FIRST (main enables it right after
 * Page.enable) — an unenabled domain answers "'Network.setCookie' wasn't
 * found" (a probe-proven -32601, issue 453 review) — and a set that DevTools
 * itself reports as failed must be a hard error, never a silent continue:
 * every authed contract would otherwise read as a session bounce instead of
 * surfacing the delivery refusal. Exported for the session tests, which drive
 * it with a fake DevTools client (the same pattern launchChromeWithRetry and
 * missingRequiredEnv are exported for).
 */
export async function setSessionCookie(client, sessionId, value, baseUrl) {
  const result = await client.send("Network.setCookie", {
    name: SESSION_COOKIE_NAME,
    value,
    url: baseUrl,
  }, sessionId);
  if (result?.success !== true) {
    throw new Error(
      `Network.setCookie could not set the "${SESSION_COOKIE_NAME}" session cookie on ${baseUrl} ` +
        `(DevTools answered ${JSON.stringify(result) ?? "nothing"}) — signed-in contracts cannot run without it`,
    );
  }
}

/**
 * The terminal landing states of an authed contract's navigation. The target
 * URL itself, or a bounce: a session the page refuses lands on `/` (no
 * usable session) or `/session?reason=...` (an identity the ledger cannot
 * vouch for), and a session it admits at the WRONG ROLE lands on
 * `/dashboard` — requireMemberPageSession re-reads the role from the
 * database and /moderation redirects non-moderators there. Every bounce is
 * a row-level render failure naming the landed URL, never the contract-drift
 * hard stop and never a poll timeout. `staleDocument` mirrors the in-page
 * `__geometryStaleDocument` marker: the DEPARTING document carries it, so
 * its location can never satisfy the bounce arm. The poll predicate in
 * main() is this function's literal in-page string mirror — change the two
 * together. Exported so tests can pin each landing state.
 */
export function authedLandingState(targetUrl, href, staleDocument) {
  if (href === targetUrl) return "target";
  if (staleDocument === true) return "pending";
  const { pathname } = new URL(href);
  if (pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/session")) {
    return "bounce";
  }
  return "pending";
}

/**
 * The page contracts, the table this check exists to keep extensible: a new
 * page's geometry cover is one more entry, not one more test file.
 *
 * `styleProof` proves the real stylesheet is applied before anything is
 * measured — a computed property a stylesheet rule sets on the contract
 * element, alongside the value the rule sets and the value the element would
 * read if the stylesheet had NOT applied. The proof's `defaultRead` is the UA
 * default for THIS contract element (a `<button>` renders `inline-block`
 * unstyled); re-pointing the contract at a different element type means
 * re-deriving it. A run that measures without styles is not evidence, so a
 * proof that reads the default refuses to measure.
 *
 * `renderRoot` is the page's own structural anchor (the skip-link target the
 * landing page puts on its <main>), used to tell "the page did not render"
 * (root absent — an error page or a dead server) apart from "the page
 * rendered but the contract selector is gone" (contract drift). The two are
 * diagnosed differently: the error fallback in src/components/error-fallback.tsx
 * renders the same .landing-hero/.action-button classes, so the contract
 * selector alone cannot make the distinction.
 *
 * `authAs` (optional) signs the page in as a fixture user while measuring —
 * "member" or "moderator" (issue 453). The session cookie is set fresh before
 * each authed contract's navigation (overwriting the previous role's cookie),
 * and a navigation that bounces to / , /session?... , or /dashboard (a role
 * bounce) is a ROW-LEVEL render failure of that contract naming the landed
 * URL — never the contract-drift hard stop and never a poll timeout.
 */
const PAGE_CONTRACTS = [
  // ORDER: the signed-out / contract must stay FIRST. The authed contracts
  // below it set their session cookie before each navigation; a reorder
  // would leave / measured with a cookie in the jar, where it redirects to
  // /dashboard instead of rendering.
  {
    page: "/",
    renderRoot: "#main-content",
    viewports: [
      [1440, 800],
      // Restored to the original tight pin: the primary action's bottom sits
      // at 668.4px IDENTICALLY in both measurement environments (this box
      // and the GitHub runner) — zero observed spread — so the issue-111 pin
      // keeps its teeth. The ~100px policy applies only where the two
      // environments disagree (see /dashboard's narrow rows) or headroom is
      // otherwise thin.
      [1280, 700],
    ],
    primaryAction: ".landing-hero .action-button",
    styleProof: {
      property: "display",
      stylesheetValue: "inline-flex",
      defaultRead: "inline-block",
    },
  },

  /*
   * The signed-in contracts (issue 453). Each row's renderRoot is the
   * `<main id="main-content">` anchor AppShell renders on every authed page
   * (src/components/app-shell.tsx) — present only when the page truly
   * rendered, never on an error page or a bounce. `authAs` signs the run in
   * as one of the seeded fixture users through the session fixture above;
   * the database re-read in requireMemberPageSession is the role authority,
   * so the seeded row, not the JWT's role claim, is what admits each page.
   *
   * Primary controls are derived from the page source, first match in
   * document order; the style proof's defaultRead is the UA default for the
   * element the selector actually lands on (`<a>` reads `inline`,
   * `<button>` reads `inline-block`), so re-pointing a selector at a
   * different element type means re-deriving it.
   *
   * Fold heights are measured, not guessed — against BOTH environments that
   * enforce them. The first pass pinned ~30-40px of headroom over this box's
   * measurements alone, and CI red-lined /dashboard's two narrow rows: its
   * text-wrap-sensitive ledger-note link laid out ~42-57px taller on the
   * GitHub runner (1042.9px bottom at 780 wide vs 985.6px here; 1163.7px vs
   * 1121.7px at 520) while every other row matched to the decimal. The rule
   * now: each fold gives ~100px of headroom over the WORSE of the two
   * environments' bottoms, and a row with under 60px on either gets raised
   * even when it passes. Per-row comments carry the measured bottoms (this
   * box's number first, the runner's where the two differ). The rows pin the
   * fixture's empty-ledger state — what CI's scratch database renders — not
   * an arbitrary member's data.
   */

  // The ledger-note aside's "Register one repository" link (src/app/dashboard/page.tsx):
  // the page's next move for a member with nothing registered yet, which is
  // exactly the state the fixture user seeds. The link is an <a>, so an
  // unstyled read is `inline` while .text-link sets `inline-block`.
  {
    page: "/dashboard",
    authAs: "member",
    renderRoot: "#main-content",
    viewports: [
      // Measured bottom 778.8px on both environments; 800 left only ~21px of
      // headroom, so the fold rises to 880 (~101px).
      [1440, 880],
      // Measured bottom 775.6px on both environments; 810 left ~34px, so
      // 880 pins ~104px.
      [1280, 880],
      // THIS is the row class that taught the two-environment rule: the
      // ledger-note link text-wrapped taller on the GitHub runner —
      // bottom 985.6px here vs 1042.9px there (the 780px breakpoint stacks
      // the dashboard grid, and the runner's fonts wrapped the link onto an
      // extra line). 1020 (a ~34px pin over the local number) failed CI at
      // 1042.9. 1140 gives ~97px over the WORSE measurement.
      [780, 1140],
      // Same wrap spread at this width: bottom 1121.7px here vs 1163.7px on
      // the runner (the 520px breakpoint's narrower shell and single-column
      // fields). 1160 failed CI at 1163.7. 1260 gives ~96px over the worse.
      [520, 1260],
    ],
    primaryAction: ".ledger-note .text-link",
    styleProof: {
      property: "display",
      stylesheetValue: "inline-block",
      defaultRead: "inline",
    },
  },

  // The filter form's "Apply filters" submit button (src/app/issues/page.tsx),
  // rendered on every /issues view, empty list or not, so the contract holds
  // however the ledger fills. The button is a <button>, unstyled read
  // `inline-block`; .action-button sets `inline-flex`.
  {
    page: "/issues",
    authAs: "member",
    renderRoot: "#main-content",
    viewports: [
      // Measured bottom 727.6px on both environments — ~72px of headroom at
      // the 800px fold, above the raise threshold, so it stays.
      [1440, 800],
      // Measured bottom 724.4px on both environments; 760 left ~36px, so
      // 825 pins ~101px.
      [1280, 825],
      // Measured bottom 691.5px on both environments (the filter form's
      // fields stack at the 780px breakpoint); 725 left ~34px, so 795 pins
      // ~104px.
      [780, 795],
      // Measured bottom 719.6px on both environments; 755 left ~35px, so
      // 820 pins ~100px.
      [520, 820],
    ],
    primaryAction: ".surface .action-button",
    styleProof: {
      property: "display",
      stylesheetValue: "inline-flex",
      defaultRead: "inline-block",
    },
  },

  // The empty-ledger state's "Find eligible issues" link (src/app/settlements/page.tsx).
  // The fixture user has no settlements, so the page renders its empty state;
  // this contract pins THAT view — a contract for the populated history card
  // would need a fixture with settled rows. The link is an <a>, unstyled read
  // `inline`; .text-link sets `inline-block`.
  {
    page: "/settlements",
    authAs: "member",
    renderRoot: "#main-content",
    viewports: [
      // Measured bottom 742.5px on both environments; 800 left ~58px of
      // headroom — just under the raise threshold — so 845 pins ~102px.
      [1440, 845],
      // Measured bottom 739.3px on both environments; 775 left ~36px, so
      // 840 pins ~101px.
      [1280, 840],
      // Measured bottom 621.6px on both environments; 655 left ~33px, so
      // 725 pins ~103px.
      [780, 725],
      // Measured bottom 656px on both environments; 690 left ~34px, so 760
      // pins ~104px.
      [520, 760],
    ],
    primaryAction: ".empty-state .text-link",
    styleProof: {
      property: "display",
      stylesheetValue: "inline-block",
      defaultRead: "inline",
    },
  },

  // The audit form's "Open audit" button (src/components/open-audit-form.tsx,
  // rendered by src/app/moderation/page.tsx's first action section) — the
  // ladder's first rung and the page's primary control. Only a moderator's
  // session renders the page at all; a member session bounces to /dashboard
  // (a role bounce — a terminal landing state alongside / and /session*) and
  // the row fails as a render failure naming the landed URL. The
  // button is a <button>, unstyled read `inline-block`; .action-button sets
  // `inline-flex`.
  {
    page: "/moderation",
    authAs: "moderator",
    renderRoot: "#main-content",
    viewports: [
      // No consumer-scale fold holds this action: the audit form's five
      // fields and its textarea all precede the button, putting its bottom
      // at ~1272-1275px on the desktop widths (identical on both
      // environments). The heights below pin the button's measured position
      // with ~100px of headroom, so a large downward move still turns the
      // row red; what they give up is the above-the-fold claim a shorter
      // fold would carry.
      [1440, 1375],
      [1280, 1375],
      // Measured bottom 1152.8px on both environments (form-grid columns
      // stay side by side at this width, but the stacked audit section sits
      // lower); 1190 left ~37px, so 1255 pins ~102px.
      [780, 1255],
      // Measured bottom 1308.9px on both environments (the 520px breakpoint
      // stacks the form's fields single-column); 1345 left ~36px, so 1410
      // pins ~101px.
      [520, 1410],
    ],
    primaryAction: ".open-audit-form .action-button",
    styleProof: {
      property: "display",
      stylesheetValue: "inline-flex",
      defaultRead: "inline-block",
    },
  },
];

/**
 * Discover the Chrome binary: env override first, then the common names on
 * PATH and /usr/bin.
 */
function discoverChrome() {
  const searchDirs = [...new Set((process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .concat("/usr/bin"))];

  const candidates = [];
  if (process.env.LAYOUT_CHECK_CHROME) candidates.push(process.env.LAYOUT_CHECK_CHROME);
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    for (const dir of searchDirs) candidates.push(join(dir, name));
  }

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    console.error(
      "no Chrome/Chromium binary found (looked for google-chrome-stable, google-chrome, " +
        "chromium, chromium-browser on PATH and /usr/bin). " +
        "Set LAYOUT_CHECK_CHROME to the binary's path to override.",
    );
    process.exit(2);
  }
  return found;
}

/** Wait for a WebSocket to open. */
function openSocket(url) {
  return new Promise((resolveOpen, rejectOpen) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolveOpen(ws));
    ws.addEventListener("error", () => rejectOpen(new Error("DevTools socket failed to open")));
  });
}

/** Minimal CDP client: one browser-level socket, flat sessions. */
class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
        else entry.resolve(message.result);
        return;
      }
      for (const handler of this.eventHandlers) handler(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      // The timer is cleared the moment the response arrives (and in its own
      // callback), so a finished run never idles behind pending CDP timers.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  on(handler) {
    this.eventHandlers.push(handler);
  }
}

/**
 * Wait for one Chrome attempt to print its DevTools endpoint. An attempt
 * fails one of three ways — the taxonomy the launcher's messages implement:
 * the child exits (rejects immediately, the error carrying `exitCode`), the
 * child could not be spawned at all (the process object's `error` event, no
 * `exit` following — unlistened, that failure crashes as an unhandled event
 * error instead of a retryable launch failure; tagged `spawnError`), or the
 * attempt's budget expires while the child is still alive and silent (tagged
 * `silentStart`). Its rejection messages carry no retry context — the
 * launcher owns that.
 */
function waitForDevToolsUrl(child, budgetMs = 20000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        finish();
        resolve(match[1]);
      }
    };
    const onExit = (code) => {
      finish();
      const error = new Error(`chrome exited early with code ${code}`);
      error.exitCode = code;
      reject(error);
    };
    const onError = (cause) => {
      finish();
      const error = new Error(`chrome could not be spawned: ${cause.message}`);
      error.spawnError = cause;
      reject(error);
    };
    const timer = setTimeout(() => {
      finish();
      const error = new Error(`chrome alive but silent for ${budgetMs}ms`);
      error.silentStart = true;
      reject(error);
    }, budgetMs);
    const finish = () => {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stderr.on("data", onData);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

/** The stderr tail carried in every launch-failure message. */
const STDERR_TAIL_LINES = 15;

/** The captured stderr's tail, for failure messages. */
function stderrTail(text) {
  const trimmed = text.trimEnd();
  if (trimmed === "") return "(no chrome stderr captured)";
  return trimmed.split("\n").slice(-STDERR_TAIL_LINES).join("\n");
}

/**
 * Launch Chrome and wait for its DevTools endpoint, retrying the whole launch
 * while attempts remain (issue 447): a slow Chrome start on a loaded runner
 * used to get one flat 20s budget and fail the required check, so the budget
 * is now per attempt and each failed attempt is retried with a fresh one. A
 * failed attempt's child is killed (SIGKILL) before relaunching so nothing
 * leaks. Every rejection carries the captured stderr tail, so a genuine
 * launch failure is diagnosable from the CI log alone, and the three failure
 * classes — an early exit, a spawn failure, an alive-but-silent start — are
 * named distinctly. `spawnChild`, `attempts` and `budgetMs` are injectable
 * so tests drive this with fake children and reduced budgets.
 */
export async function launchChromeWithRetry({
  command,
  args,
  spawnChild = spawn,
  attempts = 3,
  budgetMs = 20000,
}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError(`attempts must be a whole number >= 1, got ${attempts}`);
  }

  const stderrChunks = [];
  let lastFailure = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const child = spawnChild(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const collect = (chunk) => stderrChunks.push(chunk.toString());
    child.stderr.on("data", collect);

    try {
      const browserUrl = await waitForDevToolsUrl(child, budgetMs);
      // The child is handed back alive: drop the accumulating collector and
      // let stderr keep flowing, discarded, for the measurement's lifetime.
      child.stderr.off("data", collect);
      child.stderr.resume();
      return { child, browserUrl };
    } catch (error) {
      // A failed attempt must not leak its child, and its stderr listener is
      // retired with it; chunks captured so far stay in stderrChunks.
      child.kill("SIGKILL");
      child.stderr.off("data", collect);
      lastFailure = error.silentStart
        ? { kind: "silent" }
        : error.spawnError
          ? { kind: "spawn", cause: error.spawnError }
          : { kind: "exit", code: error.exitCode };
    }
  }

  const attemptNote = ` after ${attempts} attempt(s)`;
  const tail = stderrTail(stderrChunks.join(""));
  if (lastFailure.kind === "silent") {
    throw new Error(
      `chrome alive but silent (no "DevTools listening on" line within ${budgetMs}ms)${attemptNote}\n${tail}`,
    );
  }
  if (lastFailure.kind === "spawn") {
    throw new Error(`chrome could not be spawned (${lastFailure.cause.message})${attemptNote}\n${tail}`);
  }
  throw new Error(`chrome exited early with code ${lastFailure.code}${attemptNote}\n${tail}`);
}

/** The server log's tail, for error messages. */
async function readFileHead(path) {
  try {
    const text = await readFile(path, "utf8");
    const lines = text.trimEnd().split("\n");
    return lines.slice(-15).join("\n");
  } catch {
    return "(no server log)";
  }
}

/**
 * The environment the spawned `next start` runs under. NextAuth v5 refuses
 * to honor a session cookie for a host it does not trust, and under a
 * production server (`next start`) it grants that trust only from the
 * environment (installed @auth/core lib/utils/env.js: trustHost comes from
 * AUTH_URL or AUTH_TRUST_HOST). Measured live (issue 453): without it, every
 * authed contract's request is answered UntrustedHost and bounces to /,
 * reading exactly like a rejected session. The gate's own server is a
 * loopback measurement target, so it spawns with AUTH_TRUST_HOST=true unless
 * the caller's environment already carries an explicit trust decision — the
 * helper never downgrades one. A --base-url target's environment is not this
 * process's business; its operator needs the same setting, and the
 * auth-bounce failure message names it.
 */
export function spawnedServerEnv(env = process.env) {
  const existing = env.AUTH_TRUST_HOST;
  return {
    ...env,
    AUTH_TRUST_HOST: existing !== undefined && existing !== "" ? existing : "true",
  };
}

/** SIGTERM, then SIGKILL once a grace elapses. */
async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let waited = 0; waited < 5000; waited += 100) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
  child.kill("SIGKILL");
}

/**
 * Spawn `next start` from the production build and wait for readiness, or
 * return null when --base-url was given. Readiness is this child's own
 * answer: the loop checks the child's liveness first and after any successful
 * response, so a stale server squatting on the port can never be mistaken for
 * this run's build. Any throw kills the child before propagating — a failed
 * start must not leak a server.
 */
async function startServer(workDir) {
  const dotNext = join(repoRoot, ".next");
  if (!existsSync(dotNext)) {
    console.error(`${dotNext} not found — run pnpm build first`);
    process.exit(2);
  }

  const logPath = join(workDir, "next-start.log");
  const logFile = await open(logPath, "a");
  try {
    const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
      cwd: repoRoot,
      env: spawnedServerEnv(process.env),
      stdio: ["ignore", logFile.fd, logFile.fd],
    });

    try {
      const childDied = () => child.exitCode !== null || child.signalCode !== null;
      const death = () => `next start exited with code ${child.exitCode ?? child.signalCode}`;

      /**
       * Readiness needs evidence ONLY this child can produce: next prints
       * "Ready in ..." to its captured output once it is serving. A foreign
       * server squatting on the port answers fetches in milliseconds while
       * this child is still reaching its bind, so an answering socket alone
       * proves nothing — the ready line does.
       */
      const logHas = async (needle) =>
        readFile(logPath, "utf8").then(
          (text) => text.includes(needle),
          () => false,
        );

      const deadline = Date.now() + 60000;
      let everAnswered = false;
      for (;;) {
        if (childDied()) {
          throw new Error(`${death()} before answering on ${BASE_URL}\n${await readFileHead(logPath)}`);
        }
        if (await logHas("EADDRINUSE")) {
          throw new Error(
            `next start could not bind its port — a foreign server is squatting on ${BASE_URL}` +
              `\n${await readFileHead(logPath)}`,
          );
        }
        let answered = false;
        try {
          const response = await fetch(`${BASE_URL}/`);
          if (response.body) await response.body.cancel(); // any HTTP response counts; release the socket
          answered = true;
        } catch {
          // no HTTP response yet
        }
        if (answered) {
          everAnswered = true;
          if (childDied()) {
            throw new Error(
              `something answered on ${BASE_URL}, but ${death()} — refusing to measure a foreign server` +
                `\n${await readFileHead(logPath)}`,
            );
          }
          if (await logHas("Ready in")) break;
          // Something answered and this child is alive, but its ready line has
          // not landed yet — keep polling until THIS child declares readiness.
        }
        if (Date.now() > deadline) {
          if (everAnswered) {
            throw new Error(
              `a server answered on ${BASE_URL}, but this run's next start never printed its ready line ` +
                `within 60s — refusing to measure a foreign server\n${await readFileHead(logPath)}`,
            );
          }
          throw new Error(`next start never answered on ${BASE_URL} within 60s\n${await readFileHead(logPath)}`);
        }
        await new Promise((resolveTick) => setTimeout(resolveTick, 250));
      }
      return child;
    } catch (error) {
      await stopServer(child);
      throw error;
    }
  } finally {
    await logFile.close();
  }
}

/** Evaluate an expression in the page, returning its value. */
async function evaluate(client, sessionId, expression) {
  const { result } = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(`page evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.value;
}

/** Evaluate an async expression, awaiting its promise in the page. */
async function evaluateAsync(client, sessionId, expression) {
  const { result } = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(`page evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.value;
}

/** Poll a boolean-valued expression until it evaluates true. */
async function pollFor(client, sessionId, expression, timeoutMs, waitingFor) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(client, sessionId, expression)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${waitingFor}`);
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
}

/**
 * Wait out the two layout inputs that land AFTER the load event: web fonts
 * (a cold fontconfig resolves and swaps them late, and a fallback-font layout
 * measures differently) and the frame that paints the post-font relayout.
 * Measuring before both is how a clean page reads a mutant's geometry.
 */
async function settleLayout(client, sessionId) {
  await evaluateAsync(client, sessionId, "document.fonts.ready.then(() => true)");
  await evaluateAsync(client, sessionId, "new Promise((resolve) => requestAnimationFrame(() => resolve(true)))");
}

/** Format a number as a compact measurement. */
const px = (value) => `${Math.round(value * 10) / 10}px`;

/**
 * The in-page measurement for one contract: the primary action's rect, the
 * style-proof property, and the viewport bounds, all read in the page.
 * Selectors are interpolated with JSON.stringify, never string-concatenated.
 * A missing render root and a missing contract element are returned as
 * distinct shapes so the caller can tell "page did not render" from
 * "contract drift".
 */
function measureExpression(selector, rootSelector, styleProof) {
  return `(() => {
  const root = document.querySelector(${JSON.stringify(rootSelector)});
  if (!root) return { rootFound: false };
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return { rootFound: true, found: false };
  const proofProperty = ${JSON.stringify(styleProof.property)};
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    rootFound: true,
    found: true,
    proofValue: style[proofProperty],
    width: rect.width,
    height: rect.height,
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
  };
})()`;
}

/**
 * The assertions of one page/viewport row, evaluated against one measurement.
 * Returns the list of failed assertions with measured numbers; an empty list
 * is a PASS row. Assertion (a) — the contract selector matching nothing on a
 * RENDERED page — is handled by the caller: it is a hard fail that stops the
 * whole run, because a faithful markup rewrite must re-point the contract
 * visibly rather than silently drop coverage.
 */
function failedAssertions(measured, styleProof) {
  const failures = [];

  if (measured.proofValue === styleProof.defaultRead) {
    failures.push(
      `stylesheet not applied (${styleProof.property} reads the default ` +
        `"${measured.proofValue}") — refusing to measure`,
    );
    return failures;
  }

  if (!(measured.width > 0 && measured.height > 0)) {
    failures.push(
      `primary action not visible (measured ${px(measured.width)} x ${px(measured.height)})`,
    );
    return failures;
  }

  const bounds = [];
  if (!(measured.top >= 0)) bounds.push(`top ${px(measured.top)} < 0`);
  if (!(measured.left >= 0)) bounds.push(`left ${px(measured.left)} < 0`);
  if (!(measured.right <= measured.innerWidth)) {
    bounds.push(`right ${px(measured.right)} > innerWidth ${px(measured.innerWidth)}`);
  }
  if (!(measured.bottom <= measured.innerHeight)) {
    bounds.push(`bottom ${px(measured.bottom)} > fold ${px(measured.innerHeight)}`);
  }
  if (bounds.length > 0) {
    failures.push(`primary action out of bounds: ${bounds.join(", ")}`);
  }

  if (!(measured.scrollWidth <= measured.innerWidth)) {
    failures.push(
      `horizontal page overflow: scrollWidth ${px(measured.scrollWidth)} > ` +
        `innerWidth ${px(measured.innerWidth)}`,
    );
  }

  return failures;
}

/** Short human label for a viewport pair. */
const viewportLabel = ([width, height]) => `${width}x${height}`;

/**
 * This run's HTTP status for a page, for render-failure diagnosis. Fetches
 * with redirect:"manual" so a bounced contract reports its real 307 — the
 * default follow would land the status on the redirect target (a role
 * bounce read "HTTP 200", naming the /dashboard page the bounce PRODUCED
 * instead of the /moderation response that caused it). The other
 * render-failure paths read the same as before: a dead server still answers
 * "no response", and error pages do not redirect.
 */
async function probeStatus(page) {
  try {
    const response = await fetch(`${BASE_URL}${page}`, { redirect: "manual" });
    if (response.body) await response.body.cancel();
    return response.status;
  } catch {
    return "no response";
  }
}

async function main() {
  // The gate process itself needs DATABASE_URL (seeding) and AUTH_SECRET
  // (the session fixture) from the same .env the preflight advertises — the
  // spawned server loads it for itself, but these reads happen in-process
  // (issue 453 round 4). Real environment wins, matching migrate's
  // --env-file-if-exists behavior; .env at the repo root only.
  await loadRepoEnvFile();

  const spawned = BASE_URL === `http://127.0.0.1:${PORT}`;

  // The environment preflight (issue 471) runs only when this run spawns its
  // own server, and before mkdtemp, startServer and launchChromeWithRetry, so
  // a refusal leaves nothing spawned and nothing listening on the port — the
  // same convention as the chrome-not-found and .next-not-found refusals.
  if (spawned) {
    const missing = missingRequiredEnv();
    if (missing.length > 0) {
      console.error(missingEnvMessage(missing));
      process.exit(2);
    }
  }

  const chrome = discoverChrome();
  const workDir = await mkdtemp(join(tmpdir(), "page-geometry-"));
  let server = null;
  let failed = false;
  let hardFailure = null;

  try {
    if (spawned) server = await startServer(workDir);

    // The session fixture (issue 453) seeds before any contract runs — in
    // --base-url mode too: the database is whatever DATABASE_URL names.
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl === "") {
      throw new Error(
        "DATABASE_URL is not set — the geometry fixture users cannot be seeded. " +
          "The gate prepares its signed-in session fixture in --base-url mode too; " +
          "point DATABASE_URL at the database the target server renders against.",
      );
    }
    const fixtureUsers = await seedFixtureUsers({ databaseUrl });
    // The run's first write, made visible at the moment it happens — host
    // and database name only, never the credentials in the URL.
    let seededInto;
    try {
      const parsed = new URL(databaseUrl);
      seededInto = `${parsed.host}${parsed.pathname}`;
    } catch {
      seededInto = "(database url unparsable)";
    }
    console.log(`seeded fixture users into ${seededInto}`);

    // The launch retries itself (issue 447): a failed attempt is killed and
    // relaunched inside launchChromeWithRetry, so reaching this line means
    // the child is alive and its DevTools endpoint is known.
    const { child, browserUrl } = await launchChromeWithRetry({
      command: chrome,
      args: [
        "--headless=new",
        "--remote-debugging-port=0",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(workDir, "profile")}`,
        "about:blank",
      ],
    });

    try {
      const client = new DevTools(await openSocket(browserUrl));
      const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
      await client.send("Page.enable", {}, sessionId);
      // Network domain commands (the session-cookie set, issue 453) answer
      // "'Network.setCookie' wasn't found" until the domain is enabled on the
      // flat session; enabling it on a signed-out-only run is harmless.
      await client.send("Network.enable", {}, sessionId);

      const rows = [];
      pageLoop:
      for (const contract of PAGE_CONTRACTS) {
        // An authed contract re-sets its session cookie before EVERY
        // navigation: the member/moderator switch overwrites the same cookie,
        // and a re-set is idempotent and cheap (issue 453).
        if (contract.authAs !== undefined) {
          const role = AUTH_AS_ROLES[contract.authAs];
          if (role === undefined) {
            throw new Error(
              `unknown authAs "${contract.authAs}" on the ${contract.page} contract — ` +
                `expected "member" or "moderator"`,
            );
          }
          await setSessionCookie(client, sessionId, mintSessionCookieValue({
            secret: fixtureAuthSecret(),
            userId: role === "MEMBER" ? fixtureUsers.memberUserId : fixtureUsers.moderatorUserId,
            role,
          }), BASE_URL);
        }

        const url = `${BASE_URL}${contract.page}`;
        // Mark the document the navigation departs from, so a bounce poll can
        // tell "a document the new navigation produced" from the previous
        // page still sitting at '/' (whose pathname would otherwise satisfy
        // the bounce predicate before the navigation even commits).
        await evaluate(client, sessionId, "window.__geometryStaleDocument = true");
        await client.send("Page.navigate", { url }, sessionId);
        if (contract.authAs === undefined) {
          // The URL match keeps the poll from being satisfied by the departing
          // about:blank document before the navigation commits.
          await pollFor(client, sessionId,
            `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`,
            30000,
            `"${url}" to finish loading (document.readyState complete at that URL, no redirect)`);
        } else {
          // Settle at the target or at a bounce — / , /session?... , or
          // /dashboard (a role bounce; authedLandingState above names what
          // each means) — then diagnose from where the browser actually
          // landed. The stale-document flag keeps the departing page (already
          // complete) from satisfying the bounce arm before the navigation
          // commits. This expression is the in-page string mirror of
          // authedLandingState; change the two together.
          await pollFor(client, sessionId,
            `document.readyState === 'complete' && (location.href === ${JSON.stringify(url)} ` +
              `|| (!window.__geometryStaleDocument && (location.pathname === '/' ` +
              `|| location.pathname === '/dashboard' || location.pathname.startsWith('/session'))))`,
            30000,
            `"${url}" to finish loading (document.readyState complete at the target or a bounced URL, no hang)`);
          const landedAt = await evaluate(client, sessionId, "location.href");
          if (authedLandingState(url, landedAt, false) !== "target") {
            // A bounce — rejected cookie, untrusted host, or wrong role — is
            // the render-failure branch: HTTP status plus the landed URL,
            // never the contract-drift hard stop and never a poll timeout.
            const status = await probeStatus(contract.page);
            failed = true;
            console.log(
              `${contract.page}: FAIL — signed-in page did not render (HTTP ${status}); ` +
                `the session was not admitted (a rejected cookie, an untrusted host, or a role bounce), ` +
                `the browser landed on ${landedAt} ` +
                `(a server that does not trust the request host drops sessions silently: ` +
                `the spawned server grants itself AUTH_TRUST_HOST=true; a --base-url ` +
                `target must be started with it)`,
            );
            rows.push({ label: contract.page, failures: ["auth"] });
            continue;
          }
        }
        await settleLayout(client, sessionId);

        for (const viewport of contract.viewports) {
          await client.send("Emulation.setDeviceMetricsOverride", {
            width: viewport[0],
            height: viewport[1],
            deviceScaleFactor: 1,
            mobile: false,
          }, sessionId);
          // The override forces a relayout; measure only after fonts and the
          // painting frame have settled the new layout.
          await settleLayout(client, sessionId);

          const measured = await evaluate(client, sessionId, measureExpression(contract.primaryAction, contract.renderRoot, contract.styleProof));
          const label = `${contract.page} @ ${viewportLabel(viewport)}`;

          if (!measured.rootFound) {
            // The document lacks the page's structural anchor: this is a
            // render failure (error page, dead server), not contract drift.
            const status = await probeStatus(contract.page);
            failed = true;
            console.log(
              `${label}: FAIL — page did not render (HTTP ${status}); ` +
                `document lacks "${contract.renderRoot}"`,
            );
            rows.push({ label, failures: ["render"] });
            break;
          }

          if (!measured.found) {
            // The page rendered but the contract element is gone: a markup
            // rewrite must re-point the contract VISIBLY, so stop the run —
            // after cleanup, via the flag below, never via process.exit.
            hardFailure =
              `page contract out of date — update the selector in scripts/check-page-geometry.mjs ` +
              `("${contract.primaryAction}" matched nothing on ${contract.page} at ` +
              `${viewportLabel(viewport)}; the page rendered — "${contract.renderRoot}" is present)`;
            break pageLoop;
          }

          const failures = failedAssertions(measured, contract.styleProof);
          if (failures.length === 0) {
            console.log(
              `${label}: PASS (action ${px(measured.width)} x ${px(measured.height)} at ` +
                `(${px(measured.left)}, ${px(measured.top)}), bottom ${px(measured.bottom)} <= fold ` +
                `${px(measured.innerHeight)}, scrollWidth ${px(measured.scrollWidth)})`,
            );
          } else {
            failed = true;
            console.log(`${label}: FAIL — ${failures.join("; ")}`);
          }
          rows.push({ label, failures });
        }
      }

      if (!hardFailure) {
        const passed = rows.filter((row) => row.failures.length === 0).length;
        console.log(`\n${rows.length} page/viewport checks: ${passed} pass, ${rows.length - passed} fail`);
      }
    } finally {
      child.kill("SIGKILL");
    }
  } finally {
    await stopServer(server);
  }

  if (hardFailure) {
    console.error(hardFailure);
    process.exitCode = 1;
  }
  if (failed) process.exitCode = 1;
}

// Run only when invoked as a script (node scripts/check-page-geometry.mjs);
// importing the module — the tests do — must not spawn a server or Chrome.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
