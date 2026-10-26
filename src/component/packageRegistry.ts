import { v } from "convex/values";
import { Effect, Option, pipe } from "effect";
import { action, env } from "./_generated/server";
import { sameClaims } from "./claims";
import { npmRegistryLayer } from "./npm/impl";
import { NpmRegistry, type SecondFactorRequired } from "./npm/interface";
import {
  account,
  createPlaceholderResult,
  registerTrustedPublisherResult,
  trustedPublisher,
  trustedPublisherClaims,
  type SecondFactorRequiredResult,
} from "./validators";

/**
 * The `PackageRegistryComponentApi` functions (jive-abstract-connector-package-registry), for npm. Each action is
 * a runtime boundary: it runs one Effect program against the configured registry, and an unexpected failure
 * becomes the action's error, with its message.
 */

const NPM_REGISTRY_URL = "https://registry.npmjs.org";

/**
 * The version a placeholder is published at. npm points `latest` at a package's first version whatever tag it is
 * published under, so the placeholder is the lowest version there is, and CI's first release replaces it.
 */
const PLACEHOLDER_VERSION = "0.0.0";

function runAgainstRegistry<A, E extends { readonly message: string }>(program: Effect.Effect<A, E, NpmRegistry>): Promise<A> {
  return Effect.runPromise(pipe(
    program,
    Effect.mapError((e) => new Error(e.message)),
    Effect.provide(npmRegistryLayer(env.NPM_REGISTRY_URL ?? NPM_REGISTRY_URL)),
  ));
}

function secondFactorRequired({ approval }: SecondFactorRequired): SecondFactorRequiredResult {
  return Option.match(approval, {
    onNone: () => ({ status: "secondFactorRequired" }),
    onSome: (present) => ({ status: "secondFactorRequired", approval: present }),
  });
}

/** Whether the registry has any version of the package. Public packages only: it acts as no account. */
export const packageExists = action({
  args: { packageName: v.string() },
  returns: v.boolean(),
  handler: (_ctx, { packageName }) => runAgainstRegistry(Effect.gen(function* () {
    return yield* (yield* NpmRegistry).packageExists(packageName);
  })),
});

/**
 * Creates the package by publishing `0.0.0`, holding only a package.json, as `account`, which then owns it. A
 * package that already exists is reported and left alone.
 */
export const createPlaceholder = action({
  args: { packageName: v.string(), account, oneTimePassword: v.optional(v.string()) },
  returns: createPlaceholderResult,
  handler: (_ctx, { packageName, account, oneTimePassword }) => runAgainstRegistry(pipe(
    Effect.gen(function* () {
      const npm = yield* NpmRegistry;
      if (yield* npm.packageExists(packageName)) return { status: "alreadyExists" } as const;
      yield* npm.publishPlaceholder({
        packageName,
        account,
        oneTimePassword: Option.fromNullishOr(oneTimePassword),
        version: PLACEHOLDER_VERSION,
        description: `Reserved by Jive: ${packageName}'s first release is published by its CI pipeline.`,
      });
      return { status: "created", version: PLACEHOLDER_VERSION } as const;
    }),
    Effect.catchTag("SecondFactorRequired", (e) => Effect.succeed(secondFactorRequired(e))),
  )),
});

/** The package's GitHub Actions trusted publishers, as seen by an account that maintains it. */
export const listTrustedPublishers = action({
  args: { packageName: v.string(), account },
  returns: v.array(trustedPublisher),
  handler: (_ctx, { packageName, account }) => runAgainstRegistry(Effect.gen(function* () {
    return [...yield* (yield* NpmRegistry).listTrustedPublishers({ packageName, account, oneTimePassword: Option.none() })];
  })),
});

/**
 * Lets one GitHub Actions workflow publish the package with its OIDC identity. npm requires two-factor
 * authentication on the account for any change to trust; when it asks, call again with `oneTimePassword`. An
 * identical publisher already on the package is reported instead of added again. npm deletes a new publisher
 * whose first publish hasn't happened within 2 days, so call this just before that workflow runs.
 */
export const registerTrustedPublisher = action({
  args: { packageName: v.string(), publisher: trustedPublisherClaims, account, oneTimePassword: v.optional(v.string()) },
  returns: registerTrustedPublisherResult,
  handler: (_ctx, { packageName, publisher, account, oneTimePassword }) => runAgainstRegistry(pipe(
    Effect.gen(function* () {
      const npm = yield* NpmRegistry;
      const asAccount = { packageName, account, oneTimePassword: Option.fromNullishOr(oneTimePassword) };
      const existing = (yield* npm.listTrustedPublishers(asAccount)).find((candidate) => sameClaims(candidate.claims, publisher));
      if (existing !== undefined) return { status: "alreadyRegistered", id: existing.id } as const;
      yield* npm.addTrustedPublisher({ ...asAccount, claims: publisher });
      return { status: "registered" } as const;
    }),
    Effect.catchTag("SecondFactorRequired", (e) => Effect.succeed(secondFactorRequired(e))),
  )),
});
