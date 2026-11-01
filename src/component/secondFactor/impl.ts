import { Clock, Effect, Layer, pipe } from "effect";
import type { Account } from "../validators";
import { SecondFactor, SecondFactorUnavailable, type ISecondFactor } from "./interface";
import { decodeBase32, totpCode } from "./totp";

/** npm's one-time passwords, like every common authenticator app's, are 6 digits. */
const TOTP_DIGITS = 6;

/** The account's authenticator-app secret, held by the caller: the current RFC 6238 code at the clock's time. */
class TotpSecondFactor implements ISecondFactor {
  *oneTimePassword(secondFactor: Account["secondFactor"]): Effect.fn.Return<string, SecondFactorUnavailable> {
    const key = yield* pipe(
      decodeBase32(secondFactor.secret),
      Effect.mapError((e) => new SecondFactorUnavailable({ reason: e.message })),
    );
    const unixSeconds = Math.floor(Number(yield* Clock.currentTimeMillis) / 1000);
    return yield* totpCode({ key, unixSeconds, digits: TOTP_DIGITS });
  }
}

export const secondFactorLayer: Layer.Layer<SecondFactor> = Layer.effect(SecondFactor, Effect.sync(() => new TotpSecondFactor()));
