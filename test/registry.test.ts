import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Calls the connector's functions through the example app that `jive:cicd:audit` installed it into and pushed to
 * a local Convex backend (dist/audit-app), so it runs as an installing app runs it: inside Convex's runtime. The
 * registry is a fake served by this process, answering as npm 12.2.1's source expects npm to answer, except one
 * read-only check against registry.npmjs.org. Nothing here writes to npm.
 */

const APP_DIR = resolve(import.meta.dir, "../dist/audit-app");
const TOKEN = "fake-token";
const ONE_TIME_PASSWORD = "123456";
const EXISTING = "already-on-the-registry";
const TIMEOUT = 2 * 60 * 1000;

/** Async, never spawnSync: the fake registry is served by this process, which must keep answering meanwhile. */
async function convex(args: ReadonlyArray<string>) {
  const child = Bun.spawn(["bunx", "convex", ...args], { cwd: APP_DIR, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr };
}

async function call(fn: string, args: Record<string, unknown>) {
  const result = await convex(["run", `example:${fn}`, JSON.stringify(args)]);
  if (result.exitCode !== 0) return { ok: false as const, error: result.stderr };
  return { ok: true as const, value: JSON.parse(result.stdout) };
}

/** What the fake registry was sent, and what it holds. */
const registry = {
  packages: new Set<string>([EXISTING]),
  publishes: [] as Array<{ name: string; document: any }>,
  trust: new Map<string, Array<{ id: string; type: string; claims: unknown; permissions: unknown }>>(),
  trustRequests: [] as Array<unknown>,
};

/** npm's answer when an account change needs the second factor and it offers approval in a browser. */
function secondFactorChallenge(): Response {
  return Response.json(
    { authUrl: "https://www.npmjs.com/auth/cli/approve-1", doneUrl: "https://registry.npmjs.org/-/v1/done?authId=1" },
    { status: 401, headers: { "www-authenticate": "OTP" } },
  );
}

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorized = request.headers.get("authorization") === `Bearer ${TOKEN}`;
      const secondFactor = request.headers.get("npm-otp") === ONE_TIME_PASSWORD;
      const trust = url.pathname.match(/^\/-\/package\/(.+)\/trust$/);
      if (trust !== null) {
        const name = decodeURIComponent(trust[1]!);
        if (!authorized) return new Response("Unauthorized", { status: 401 });
        if (request.method === "GET") return Response.json(registry.trust.get(name) ?? []);
        if (!secondFactor) return secondFactorChallenge();
        const body = await request.json();
        registry.trustRequests.push(body);
        const configs = registry.trust.get(name) ?? [];
        registry.trust.set(name, [...configs, { id: `trust-${configs.length + 1}`, ...(body as Array<any>)[0] }]);
        return Response.json(body);
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      if (request.method === "GET") {
        return registry.packages.has(name)
          ? Response.json({ name, "dist-tags": {}, versions: {} })
          : Response.json({ error: "Not found" }, { status: 404 });
      }
      if (request.method === "PUT") {
        if (!authorized) return new Response("Unauthorized", { status: 401 });
        if (!secondFactor) return secondFactorChallenge();
        registry.publishes.push({ name, document: await request.json() });
        registry.packages.add(name);
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
  const account = { token: TOKEN };
  const publisher = { provider: "github", repository: { owner: "jive-sh", name: "example" }, workflowFile: "pipeline.yml", environment: "latest" };

  beforeAll(async () => {
    const set = await convex(["env", "set", "NPM_REGISTRY_URL", `http://127.0.0.1:${server.port}`]);
    expect(set.exitCode, set.stderr).toBe(0);
  }, TIMEOUT);

  test("packageExists reads the configured registry", async () => {
    expect(await call("packageExists", { packageName: EXISTING })).toEqual({ ok: true, value: true });
  }, TIMEOUT);

  test("createPlaceholder asks for the second factor, then publishes an installable 0.0.0", async () => {
    const packageName = "@jive-sh/placeholder-example";
    expect(await call("createPlaceholder", { packageName, account })).toEqual({
      ok: true,
      value: {
        status: "secondFactorRequired",
        approval: { pageUrl: "https://www.npmjs.com/auth/cli/approve-1", resultUrl: "https://registry.npmjs.org/-/v1/done?authId=1" },
      },
    });
    expect(await call("createPlaceholder", { packageName, account, oneTimePassword: ONE_TIME_PASSWORD }))
      .toEqual({ ok: true, value: { status: "created", version: "0.0.0" } });

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

    expect(await call("createPlaceholder", { packageName, account, oneTimePassword: ONE_TIME_PASSWORD }))
      .toEqual({ ok: true, value: { status: "alreadyExists" } });
    expect(registry.publishes).toHaveLength(1);
  }, TIMEOUT);

  test("registerTrustedPublisher asks for the second factor, registers once, then reports it registered", async () => {
    const packageName = EXISTING;
    expect(await call("registerTrustedPublisher", { packageName, publisher, account })).toMatchObject({
      ok: true,
      value: { status: "secondFactorRequired" },
    });
    expect(await call("registerTrustedPublisher", { packageName, publisher, account, oneTimePassword: ONE_TIME_PASSWORD }))
      .toEqual({ ok: true, value: { status: "registered" } });
    expect(registry.trustRequests).toEqual([[{
      type: "github",
      claims: { repository: "jive-sh/example", workflow_ref: { file: "pipeline.yml" }, environment: "latest" },
      permissions: ["createPackage"],
    }]]);

    const differentCase = { ...publisher, repository: { owner: "Jive-SH", name: "Example" } };
    expect(await call("registerTrustedPublisher", { packageName, publisher: differentCase, account, oneTimePassword: ONE_TIME_PASSWORD }))
      .toEqual({ ok: true, value: { status: "alreadyRegistered", id: "trust-1" } });
    expect(registry.trustRequests).toHaveLength(1);

    expect(await call("listTrustedPublishers", { packageName, account })).toEqual({ ok: true, value: [{ id: "trust-1", claims: publisher }] });
  }, TIMEOUT);

  test("a refused credential fails the call with the registry's answer", async () => {
    const result = await call("listTrustedPublishers", { packageName: EXISTING, account: { token: "wrong" } });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("could not list the trusted publishers of already-on-the-registry: it answered 401");
  }, TIMEOUT);
});
