import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer, pipe } from "effect";
import { TestClock } from "effect/testing";
import { secondFactorLayer } from "../src/component/secondFactor/impl";
import { SecondFactor } from "../src/component/secondFactor/interface";
import { decodeBase32, totpCode } from "../src/component/secondFactor/totp";

/**
 * RFC 6238 Appendix B (https://www.rfc-editor.org/rfc/rfc6238#appendix-B): the shared secret is the ASCII string
 * "12345678901234567890", the step 30 seconds from the Unix epoch, and these are its SHA-1 codes at 8 digits.
 */
const RFC_SECRET = new TextEncoder().encode("12345678901234567890");
const RFC_SHA1_VECTORS: ReadonlyArray<readonly [unixSeconds: number, code: string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

/** The RFC's secret as authenticator apps show it: base32 of those 20 bytes (RFC 4648 §6). */
const RFC_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totpCode", () => {
  for (const [unixSeconds, code] of RFC_SHA1_VECTORS) {
    test(`matches RFC 6238 at ${unixSeconds}s`, async () => {
      expect(await Effect.runPromise(totpCode({ key: RFC_SECRET, unixSeconds, digits: 8 }))).toBe(code);
    });
  }

  test("a 6-digit code is the 8-digit code's last 6 digits, as truncation takes the value modulo 10^digits", async () => {
    for (const [unixSeconds, code] of RFC_SHA1_VECTORS) {
      expect(await Effect.runPromise(totpCode({ key: RFC_SECRET, unixSeconds, digits: 6 }))).toBe(code.slice(2));
    }
  });

  test("every second of a 30-second step gives the same code, and the next step another", async () => {
    const code = (unixSeconds: number) => Effect.runPromise(totpCode({ key: RFC_SECRET, unixSeconds, digits: 8 }));
    expect(await code(1111111110)).toBe("14050471");
    expect(await code(1111111139)).toBe("14050471");
    expect(await code(1111111140)).not.toBe("14050471");
  });
});

describe("decodeBase32", () => {
  test("decodes the RFC secret's base32, in any case, with spaces and padding", async () => {
    const decode = (text: string) => Effect.runPromise(decodeBase32(text));
    expect(await decode(RFC_SECRET_BASE32)).toEqual(RFC_SECRET);
    expect(await decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")).toEqual(RFC_SECRET);
    // RFC 4648 §10's test vector: BASE32("foobar") = "MZXW6YTBOI======".
    expect(new TextDecoder().decode(await decode("MZXW6YTBOI======"))).toBe("foobar");
  });

  test("refuses a character outside the alphabet without echoing the secret", async () => {
    const exit = await Effect.runPromiseExit(decodeBase32("ABCD1EFG"));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("character 5 is outside A-Z and 2-7");
    expect(JSON.stringify(exit)).not.toContain("ABCD1EFG");
  });

  test("refuses an empty secret", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(decodeBase32("  ")))).toBe(true);
  });
});

describe("the TOTP second factor", () => {
  test("answers with the 6-digit code for the clock's current time", async () => {
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(1234567890 * 1000);
      return yield* (yield* SecondFactor).oneTimePassword({ type: "totp", secret: RFC_SECRET_BASE32 });
    });
    const code = await Effect.runPromise(pipe(program, Effect.provide(Layer.merge(secondFactorLayer, TestClock.layer()))));
    expect(code).toBe("005924");
  });
});
