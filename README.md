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
stores no credentials: every function that acts as an account takes `account: { token }`, a token from that
person's npm login, so one installed component serves every person, and where tokens are kept (and how they are
renewed) is the calling app's decision. `packageExists` acts as no account and sees public packages only.

## Functions

| Function | Arguments | Returns |
| --- | --- | --- |
| `packageExists` | `{ packageName }` | `boolean` |
| `createPlaceholder` | `{ packageName, account, oneTimePassword? }` | `{ status: "created", version: "0.0.0" }` \| `{ status: "alreadyExists" }` \| second factor required |
| `listTrustedPublishers` | `{ packageName, account }` | `Array<{ id, claims }>` (GitHub Actions publishers only) |
| `registerTrustedPublisher` | `{ packageName, publisher, account, oneTimePassword? }` | `{ status: "registered" }` \| `{ status: "alreadyRegistered", id }` \| second factor required |

They are the first two steps of provisioning a new package:

1. `createPlaceholder` publishes `0.0.0`, holding only a package.json, so the package exists and `account` owns
   it. npm points `latest` at a package's first version, so `latest` is this placeholder until CI's first
   release.
2. `registerTrustedPublisher` with `{ provider: "github", repository: { owner, name }, workflowFile: "pipeline.yml",
   environment: "latest" }` lets that workflow's deploy job publish with its OIDC identity. It grants direct
   publishing (`createPackage`, what `npm trust github --allow-publish` grants), not only staged publishing.
3. CI publishes every real version. npm deletes a new trusted publisher whose first publish hasn't happened
   within 2 days ([npm docs](https://docs.npmjs.com/trusted-publishers#trusted-publisher-configuration-expiry)),
   so register it only when the workflow is about to run.

### The second factor

npm asks for the account's second factor before it publishes or changes trusted publishers. The function then
returns `{ status: "secondFactorRequired", approval?: { pageUrl, resultUrl } }`, and the caller calls it again
with `oneTimePassword`: a code from the account's authenticator or, when `approval` is present (npm's browser
flow), the `token` that `resultUrl` answers with once someone approves at `pageUrl` (it answers 202 while
pending). The component never drives a browser; Convex functions can't. After an approval that ticks npm's
"skip two-factor for 5 minutes", the following calls in that window don't ask again.

## How it is verified

`bun run jive:cicd:audit` builds the package, installs it into the example app on a local Convex backend, then
runs `test/registry.test.ts`, which calls every function through that app, inside Convex's runtime:

- against registry.npmjs.org, read-only: `packageExists` finds `convex` and not an unused name;
- against a fake registry that answers as npm's source says npm does: the 401 second-factor challenge, the
  publish document (its tarball extracts with the system's `tar`, and its integrity and shasum match), the trust
  request body, idempotent registration (owner and repository names compared case-insensitively), and a refused
  token.

Not verified against npm itself, because nothing here writes to npm: the publish and trust requests, and how
npm's live second-factor answer looks. The first live run is the first app that provisions a package with it.

## Open

- Deprecating the `0.0.0` placeholder once CI's first release lands is not built.
- How an app obtains and keeps each person's npm token, and how the second factor is answered without a person,
  are undecided.
