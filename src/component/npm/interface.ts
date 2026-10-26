import { Context, Data, type Effect, type Option } from "effect";
import type { SecondFactorUnavailable } from "../secondFactor/interface";
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

/** One registry operation acting as a person's account. */
export interface AsAccount {
  readonly packageName: string;
  readonly account: Account;
}

/** What an account-acting operation can fail with: the registry, or the account's second factor. */
export type AccountOperationError = RegistryRequestFailed | SecondFactorUnavailable;

/**
 * One npm registry, reached over its HTTP API. It holds no credential: each call that acts as an account brings
 * it. When npm refuses such a call for want of a one-time password, the call is retried once with the account's
 * second factor, so callers never see npm's second-factor challenge.
 */
export interface INpmRegistry {
  /** Whether the registry has any version of the package (404 is no; anything but 200 or 404 fails). */
  packageExists(packageName: string): Effect.fn.Return<boolean, RegistryRequestFailed>;
  /** The package's maintainers' npm usernames, or none when the package does not exist. */
  maintainers(packageName: string): Effect.fn.Return<Option.Option<ReadonlyArray<string>>, RegistryRequestFailed>;
  /** The npm username `account`'s token belongs to. */
  username(account: Account): Effect.fn.Return<string, RegistryRequestFailed>;
  /** Publishes `version` of a new package holding only `package.json`, under the `latest` dist-tag. */
  publishPlaceholder(input: AsAccount & { readonly version: string; readonly description: string }): Effect.fn.Return<
    void,
    AccountOperationError
  >;
  /**
   * The package's GitHub Actions trusted publishers, each `validated` when some version of the package names it as
   * its publisher; publishers of other providers are left out.
   */
  listTrustedPublishers(input: AsAccount): Effect.fn.Return<ReadonlyArray<TrustedPublisher>, AccountOperationError>;
  /** Adds a trusted publisher allowed to publish the package. */
  addTrustedPublisher(input: AsAccount & { readonly claims: TrustedPublisherClaims }): Effect.fn.Return<
    void,
    AccountOperationError
  >;
  /** Deletes one trusted publisher; false when the registry has no publisher with that id. */
  removeTrustedPublisher(input: AsAccount & { readonly id: string }): Effect.fn.Return<boolean, AccountOperationError>;
}

export class NpmRegistry extends Context.Service<NpmRegistry, INpmRegistry>()("NpmRegistry") {}
