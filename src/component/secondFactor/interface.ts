import { Context, Data, type Effect } from "effect";
import type { Account } from "../validators";

/** The account's second factor cannot produce a code: its secret is unusable. Never carries the secret or a code. */
export class SecondFactorUnavailable extends Data.TaggedError("SecondFactorUnavailable")<{ readonly reason: string }> {
  override get message(): string {
    return `the account's second factor is unusable: ${this.reason}`;
  }
}

/**
 * Answers the registry when it asks for the account's second factor. The npm module calls it only after npm
 * refused a request for want of a one-time password, and sends its answer as `npm-otp`.
 */
export interface ISecondFactor {
  /** The one-time password the account's second factor gives right now. Callers must not log it. */
  oneTimePassword(secondFactor: Account["secondFactor"]): Effect.fn.Return<string, SecondFactorUnavailable>;
}

export class SecondFactor extends Context.Service<SecondFactor, ISecondFactor>()("SecondFactor") {}
