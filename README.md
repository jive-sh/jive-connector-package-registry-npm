# jive-connector-package-registry-npm

A Jive connector to npm: a [Convex component](https://docs.convex.dev/components) that checks whether a package
exists, creates a new package as a person's own npm account, and lets a package's CI workflow publish it through
npm's trusted publishing. It implements the contract of
[`jive-abstract-connector-package-registry`](https://github.com/jive-sh/jive-abstract-connector-package-registry),
whose CLI builds, audits and publishes it.

## Install it in a Convex app

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import packageRegistryNpm from "jive-connector-package-registry-npm/convex.config.js";

const app = defineApp();
app.use(packageRegistryNpm);
export default app;
```

The app then calls `components.packageRegistryNpm.packageRegistry.<function>` from its actions. The component
reads one optional environment variable, `NPM_REGISTRY_URL` (default `https://registry.npmjs.org`), passed as
`app.use(packageRegistryNpm, { env: { NPM_REGISTRY_URL: … } })`. [`example/convex`](example/convex) is a working app.

## Accounts

One connection is one person's own npm account, such as the account that owns a project's packages. The component
stores no credentials: every function that acts as an account takes `account: { token, secondFactor: { type:
"totp", secret } }`, a token from that person's npm login and the shared secret of the account's authenticator app
(base32, as npm's two-factor setup shows it). One installed component serves every person, and where credentials
are kept (and how they are renewed) is the calling app's decision. `packageExists` acts as no account and sees
public packages only.

## Functions

| Function | Arguments | Returns |
| --- | --- | --- |
| `packageExists` | `{ packageName }` | `boolean` |
| `createPlaceholder` | `{ packageName, account }` | `{ status: "created", version: "0.0.0" }` \| `{ status: "alreadyExists" }` \| `{ status: "maintainedByAnotherAccount" }` |
| `listTrustedPublishers` | `{ packageName, account }` | `Array<{ id, claims, status: "validated" \| "unvalidated" }>` (GitHub Actions publishers only) |
| `registerTrustedPublisher` | `{ packageName, publisher, account }` | `{ status: "registered" }` \| `{ status: "alreadyRegistered", id }` |
| `removeTrustedPublisher` | `{ packageName, id, account }` | `{ status: "removed" }` \| `{ status: "notFound" }` |

They are the first two steps of provisioning a new package:

1. `createPlaceholder` publishes `0.0.0`, holding only a package.json, so the package exists and `account` owns
   it. npm points `latest` at a package's first version, so `latest` is this placeholder until CI's first
   release. A package that already exists is never touched: it is `alreadyExists` when `account` is among its
   maintainers (npm's `/-/whoami` against the package document's `maintainers`), and `maintainedByAnotherAccount`
   otherwise.
2. `registerTrustedPublisher` with `{ provider: "github", repository: { owner, name }, workflowFile: "pipeline.yml",
   environment: "latest" }` lets that workflow's deploy job publish with its OIDC identity. It grants direct
   publishing (`createPackage`, what `npm trust github --allow-publish` grants), not only staged publishing.
3. CI publishes every real version. npm expires a new trusted publisher whose first publish hasn't happened
   within 2 days; the expired one stays listed but "can no longer be used or edited"
   ([npm docs](https://docs.npmjs.com/trusted-publishers#trusted-publisher-configuration-expiry)). So register it
   only when the workflow is about to run, and replace one that never published with `removeTrustedPublisher`
   (npm's `npm trust revoke` request) and `registerTrustedPublisher`.

A listed publisher is `validated` when some version of the package names it as its publisher
(`_npmUser.trustedPublisher.oidcConfigId` in the package document, which npm records on a version published by
trusted publishing), and `unvalidated` otherwise. That the id there is the trust API's id is an inference: npm
documents neither field. npm's trust list reports no expiry either, so an unvalidated publisher may be waiting or
expired; the caller that registered it knows when it did. `listTrustedPublishers` logs the field names (never
values) npm's trust list returns, so the first live call shows whether npm marks expiry after all.

### The second factor

npm asks for the account's second factor before it publishes or changes trusted publishers, by refusing the
request with a 401 whose `www-authenticate` lists `otp` or whose body mentions a one-time password (npm's EOTP).
The component then computes the current code from `account.secondFactor.secret` (RFC 6238: HMAC-SHA-1, 30-second
steps, 6 digits) and sends the request once more with it as `npm-otp`. A second refusal fails the call with
"npm refused the one-time password computed from the account's authenticator secret". The secret and the codes
are never returned, logged or put in an error.

Unverified: whether npm lets an account that has a security key also use an authenticator app, and accepts its
code for these requests. npm's two-factor docs describe security keys only.

## How it is verified

`bun run jive:cicd:audit` builds the package, installs it into the example app on a local Convex backend, then
runs the tests:

- `test/totp.test.ts`: the code generator against RFC 6238's SHA-1 test vectors, base32 decoding against RFC 4648's,
  and the second factor at a fixed clock.
- `test/registry.test.ts` calls every function through the example app, inside Convex's runtime:
  - against registry.npmjs.org, read-only: `packageExists` finds `convex` and not an unused name;
  - against a fake registry that answers as npm's source says npm does and checks each `npm-otp` against the
    current code computed with Node's HMAC: the publish document (its tarball extracts with the system's `tar`,
    and its integrity and shasum match), the maintainer check, the trust request body, idempotent registration
    (owner and repository names compared case-insensitively), validated status, removal, a wrong or malformed
    secret, a refused token, and that nothing printed contains the secret or a code.

Not verified against npm itself, because nothing here writes to npm: the publish, trust and revoke requests, and
whether npm accepts a TOTP code for them.

## Open

- Deprecating the `0.0.0` placeholder once CI's first release lands is not built.
- How an app obtains and renews each person's npm token is undecided.
