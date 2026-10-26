import { Context, Data, type Effect, type Option } from "effect";
import type { Account, TrustedPublisher, TrustedPublisherClaims } from "../validators";

/** The registry answered something other than what the operation expects, or could not be reached. */
export class RegistryRequestFailed extends Data.TaggedError("RegistryRequestFailed")<{
  readonly operation: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `npm registry: could not ${this.operation}: ${this.detail}`;
  }
}

/**
 * npm wants the account's second factor. `approval` is set when it offers approval in a browser (its web flow):
 * a person or an authenticator approves at `pageUrl`, and `resultUrl` then answers with the one-time password.
 */
export class SecondFactorRequired extends Data.TaggedError("SecondFactorRequired")<{
  readonly approval: Option.Option<{ readonly pageUrl: string; readonly resultUrl: string }>;
}> {}

/** One registry operation acting as a person's account, with that account's second factor when npm asked for it. */
export interface AsAccount {
  readonly packageName: string;
  readonly account: Account;
  readonly oneTimePassword: Option.Option<string>;
}

/** One npm registry, reached over its HTTP API. It holds no credential: each call that acts as an account brings it. */
export interface INpmRegistry {
  /** Whether the registry has any version of the package (404 is no; anything but 200 or 404 fails). */
  packageExists(packageName: string): Effect.fn.Return<boolean, RegistryRequestFailed>;
  /** Publishes `version` of a new package holding only `package.json`, under the `latest` dist-tag. */
  publishPlaceholder(input: AsAccount & { readonly version: string; readonly description: string }): Effect.fn.Return<
    void,
    RegistryRequestFailed | SecondFactorRequired
  >;
  /** The package's GitHub Actions trusted publishers; publishers of other providers are left out. */
  listTrustedPublishers(input: AsAccount): Effect.fn.Return<
    ReadonlyArray<TrustedPublisher>,
    RegistryRequestFailed | SecondFactorRequired
  >;
  /** Adds a trusted publisher allowed to publish the package. */
  addTrustedPublisher(input: AsAccount & { readonly claims: TrustedPublisherClaims }): Effect.fn.Return<
    void,
    RegistryRequestFailed | SecondFactorRequired
  >;
}

export class NpmRegistry extends Context.Service<NpmRegistry, INpmRegistry>()("NpmRegistry") {}
