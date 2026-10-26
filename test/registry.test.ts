import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Calls the connector's functions through the example app that `jive:cicd:audit` installed it into and pushed to
 * a local Convex backend (dist/audit-app), so it runs as an installing app runs it: inside Convex's runtime. The
 * registry is a fake served by this process, answering as npm's source expects npm to answer, except one
 * read-only check against registry.npmjs.org. Nothing here writes to npm.
 */

const APP_DIR = resolve(import.meta.dir, "../dist/audit-app");
const TOKEN = "fake-token";
const USERNAME = "jive-test-account";
/** The RFC 6238 test secret ("12345678901234567890") in base32, as an authenticator app shows a secret. */
const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const MAINTAINED = "maintained-by-the-account";
const SOMEONE_ELSES = "maintained-by-someone-else";
const TIMEOUT = 2 * 60 * 1000;

/**
 * The 6-digit TOTP code for the test secret `stepOffset` steps from now, computed with Node's HMAC rather than the
 * connector's Web Crypto code, so the fake registry checks the connector against a second implementation.
 */
function expectedCode(stepOffset: number): string {
  const counter = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", "12345678901234567890").update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

/** A code from this step or an adjacent one, which a request crossing a step boundary may carry. */
function acceptedCode(code: string | null): boolean {
  return code !== null && [-1, 0, 1].some((offset) => expectedCode(offset) === code);
}

async function convex(args: ReadonlyArray<string>) {
  // Async, never spawnSync: the fake registry is served by this process, which must keep answering meanwhile.
  const child = Bun.spawn(["bunx", "convex", ...args], { cwd: APP_DIR, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr };
}

/** Everything `convex run` printed, across calls, to check no secret or code ever reaches a log. */
const printed: Array<string> = [];

async function call(fn: string, args: Record<string, unknown>) {
  const result = await convex(["run", `example:${fn}`, JSON.stringify(args)]);
  printed.push(result.stdout, result.stderr);
  if (result.exitCode !== 0) return { ok: false as const, error: result.stderr };
  return { ok: true as const, value: JSON.parse(result.stdout) };
}

type TrustConfig = { id: string; type: string; claims: unknown; permissions: unknown };

/** What the fake registry was sent, and what it holds. */
const registry = {
  maintainers: new Map<string, Array<string>>([[MAINTAINED, [USERNAME]], [SOMEONE_ELSES, ["someone-else"]]]),
  /** Per package, the trust configuration ids its versions were published through. */
  publishedThrough: new Map<string, Array<string>>(),
  publishes: [] as Array<{ name: string; document: any }>,
  trust: new Map<string, Array<TrustConfig>>(),
  trustRequests: [] as Array<unknown>,
  deletes: [] as Array<string>,
  oneTimePasswordsSeen: [] as Array<string>,
  nextTrustId: 1,
};

/** npm's answer when an account change needs the second factor and it offers approval in a browser. */
function secondFactorChallenge(): Response {
  return Response.json(
    { authUrl: "https://www.npmjs.com/auth/cli/approve-1", doneUrl: "https://registry.npmjs.org/-/v1/done?authId=1" },
    { status: 401, headers: { "www-authenticate": "OTP" } },
  );
}

function packument(name: string): Response {
  const maintainers = registry.maintainers.get(name);
  if (maintainers === undefined) return Response.json({ error: "Not found" }, { status: 404 });
  const versions = Object.fromEntries((registry.publishedThrough.get(name) ?? []).map((id, index) => [
    `1.0.${index}`,
    { _npmUser: { name: "GitHub Actions", trustedPublisher: { id: "github", oidcConfigId: id } } },
  ]));
  return Response.json({ name, maintainers: maintainers.map((maintainer) => ({ name: maintainer })), "dist-tags": {}, versions });
}

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorized = request.headers.get("authorization") === `Bearer ${TOKEN}`;
      const oneTimePassword = request.headers.get("npm-otp");
      if (oneTimePassword !== null) registry.oneTimePasswordsSeen.push(oneTimePassword);
      const secondFactor = acceptedCode(oneTimePassword);

      if (url.pathname === "/-/whoami") {
        return authorized ? Response.json({ username: USERNAME }) : new Response("Unauthorized", { status: 401 });
      }
      const trust = url.pathname.match(/^\/-\/package\/([^/]+)\/trust(?:\/([^/]+))?$/);
      if (trust !== null) {
        const name = decodeURIComponent(trust[1]!);
        if (!authorized) return new Response("Unauthorized", { status: 401 });
        if (request.method === "GET") return Response.json(registry.trust.get(name) ?? []);
        if (!secondFactor) return secondFactorChallenge();
        const configs = registry.trust.get(name) ?? [];
        if (request.method === "DELETE") {
          const id = decodeURIComponent(trust[2]!);
          registry.deletes.push(id);
          if (!configs.some((config) => config.id === id)) return Response.json({ error: "Not found" }, { status: 404 });
          registry.trust.set(name, configs.filter((config) => config.id !== id));
          return new Response(null, { status: 204 });
        }
        const body = await request.json();
        registry.trustRequests.push(body);
        registry.trust.set(name, [...configs, { id: `trust-${registry.nextTrustId++}`, ...(body as Array<any>)[0] }]);
        return Response.json(body);
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      if (request.method === "GET") return packument(name);
      if (request.method === "PUT") {
        if (!authorized) return new Response("Unauthorized", { status: 401 });
        if (!secondFactor) return secondFactorChallenge();
        registry.publishes.push({ name, document: await request.json() });
        registry.maintainers.set(name, [USERNAME]);
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    },
  });
});

afterAll(async () => {
  await convex(["env", "remove", "NPM_REGISTRY_URL"]);
  server.stop(true);
});

describe("against registry.npmjs.org (read-only)", () => {
  test("packageExists finds a real package and not an unused name", async () => {
    expect(await call("packageExists", { packageName: "convex" })).toEqual({ ok: true, value: true });
    expect(await call("packageExists", { packageName: `jive-no-such-package-${Date.now()}` })).toEqual({ ok: true, value: false });
  }, TIMEOUT);
});

describe("against a fake registry", () => {
  const account = { token: TOKEN, secondFactor: { type: "totp", secret: TOTP_SECRET } };
  const publisher = { provider: "github", repository: { owner: "jive-sh", name: "example" }, workflowFile: "pipeline.yml", environment: "latest" };

  beforeAll(async () => {
    const set = await convex(["env", "set", "NPM_REGISTRY_URL", `http://127.0.0.1:${server.port}`]);
    expect(set.exitCode, set.stderr).toBe(0);
  }, TIMEOUT);

  test("packageExists reads the configured registry", async () => {
    expect(await call("packageExists", { packageName: MAINTAINED })).toEqual({ ok: true, value: true });
  }, TIMEOUT);

  test("createPlaceholder answers npm's second-factor challenge with the current TOTP code and publishes an installable 0.0.0", async () => {
    const packageName = "@jive-sh/placeholder-example";
    expect(await call("createPlaceholder", { packageName, account })).toEqual({ ok: true, value: { status: "created", version: "0.0.0" } });

    const [published] = registry.publishes;
    expect(published!.name).toBe(packageName);
    const { document } = published!;
    expect(document["dist-tags"]).toEqual({ latest: "0.0.0" });
    expect(document.access).toBe("public");
    const attachment = document._attachments[`${packageName}-0.0.0.tgz`];
    const tarball = Buffer.from(attachment.data, "base64");
    expect(attachment.length).toBe(tarball.length);
    const { dist } = document.versions["0.0.0"];
    expect(dist.integrity).toBe(`sha512-${createHash("sha512").update(tarball).digest("base64")}`);
    expect(dist.shasum).toBe(createHash("sha1").update(tarball).digest("hex"));

    // The system's tar must read it the way npm will.
    const dir = mkdtempSync(join(tmpdir(), "jive-npm-placeholder-"));
    try {
      writeFileSync(join(dir, "placeholder.tgz"), tarball);
      const untar = Bun.spawnSync(["tar", "-xzf", "placeholder.tgz"], { cwd: dir, stderr: "pipe" });
      expect(untar.exitCode, untar.stderr.toString()).toBe(0);
      const manifest = JSON.parse(readFileSync(join(dir, "package/package.json"), "utf8"));
      expect(manifest).toMatchObject({ name: packageName, version: "0.0.0" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(await call("createPlaceholder", { packageName, account })).toEqual({ ok: true, value: { status: "alreadyExists" } });
    expect(registry.publishes).toHaveLength(1);
  }, TIMEOUT);

  test("createPlaceholder leaves a package another account maintains alone, and says so", async () => {
    expect(await call("createPlaceholder", { packageName: SOMEONE_ELSES, account }))
      .toEqual({ ok: true, value: { status: "maintainedByAnotherAccount" } });
    expect(await call("createPlaceholder", { packageName: MAINTAINED, account })).toEqual({ ok: true, value: { status: "alreadyExists" } });
    expect(registry.publishes).toHaveLength(1);
  }, TIMEOUT);

  test("registerTrustedPublisher answers the second factor, registers once, then reports it registered", async () => {
    const packageName = MAINTAINED;
    expect(await call("registerTrustedPublisher", { packageName, publisher, account })).toEqual({ ok: true, value: { status: "registered" } });
    expect(registry.trustRequests).toEqual([[{
      type: "github",
      claims: { repository: "jive-sh/example", workflow_ref: { file: "pipeline.yml" }, environment: "latest" },
      permissions: ["createPackage"],
    }]]);

    const differentCase = { ...publisher, repository: { owner: "Jive-SH", name: "Example" } };
    expect(await call("registerTrustedPublisher", { packageName, publisher: differentCase, account }))
      .toEqual({ ok: true, value: { status: "alreadyRegistered", id: "trust-1" } });
    expect(registry.trustRequests).toHaveLength(1);
  }, TIMEOUT);

  test("listTrustedPublishers marks a publisher validated once a version was published through it", async () => {
    const packageName = MAINTAINED;
    expect(await call("listTrustedPublishers", { packageName, account }))
      .toEqual({ ok: true, value: [{ id: "trust-1", claims: publisher, status: "unvalidated" }] });
    registry.publishedThrough.set(packageName, ["trust-1"]);
    expect(await call("listTrustedPublishers", { packageName, account }))
      .toEqual({ ok: true, value: [{ id: "trust-1", claims: publisher, status: "validated" }] });
  }, TIMEOUT);

  test("removeTrustedPublisher deletes a publisher, and reports one already gone as notFound", async () => {
    const packageName = MAINTAINED;
    expect(await call("removeTrustedPublisher", { packageName, id: "trust-1", account })).toEqual({ ok: true, value: { status: "removed" } });
    expect(registry.trust.get(packageName)).toEqual([]);
    expect(await call("removeTrustedPublisher", { packageName, id: "trust-1", account })).toEqual({ ok: true, value: { status: "notFound" } });
    expect(registry.deletes).toEqual(["trust-1", "trust-1"]);
  }, TIMEOUT);

  test("a wrong authenticator secret fails with npm's refusal, naming neither the secret nor the code", async () => {
    const wrongSecret = "JBSWY3DPEHPK3PXP";
    const before = registry.oneTimePasswordsSeen.length;
    const result = await call("registerTrustedPublisher", {
      packageName: MAINTAINED,
      publisher: { ...publisher, environment: "next" },
      account: { ...account, secondFactor: { type: "totp", secret: wrongSecret } },
    });
    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toContain("npm refused the one-time password computed from the account's authenticator secret");
    expect(error).not.toContain(wrongSecret);
    const sent = registry.oneTimePasswordsSeen.slice(before);
    expect(sent).toHaveLength(1);
    expect(error).not.toContain(sent[0]!);
  }, TIMEOUT);

  test("a secret that is not base32 fails before any code is sent", async () => {
    const before = registry.oneTimePasswordsSeen.length;
    const result = await call("removeTrustedPublisher", {
      packageName: MAINTAINED,
      id: "trust-1",
      account: { ...account, secondFactor: { type: "totp", secret: "not base32!" } },
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("the authenticator secret is not valid base32");
    expect(result.ok ? "" : result.error).not.toContain("not base32!");
    expect(registry.oneTimePasswordsSeen).toHaveLength(before);
  }, TIMEOUT);

  test("a refused credential fails the call with the registry's answer", async () => {
    const result = await call("listTrustedPublishers", { packageName: MAINTAINED, account: { ...account, token: "wrong" } });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(`could not list the trusted publishers of ${MAINTAINED}: it answered 401`);
  }, TIMEOUT);

  test("nothing the calls printed contains the authenticator secret or a code sent to npm", () => {
    const output = printed.join("\n");
    expect(output).not.toContain(TOTP_SECRET);
    expect(registry.oneTimePasswordsSeen.length).toBeGreaterThan(0);
    for (const code of registry.oneTimePasswordsSeen) expect(output).not.toMatch(new RegExp(`\\b${code}\\b`));
  });
});
