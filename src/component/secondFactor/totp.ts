import { Data, Effect } from "effect";

/**
 * Time-based one-time passwords (RFC 6238), the codes authenticator apps show: HMAC-SHA-1 over the number of
 * 30-second steps since the Unix epoch, dynamically truncated to `digits` decimal digits (RFC 4226 §5.3). The
 * shared secret is base32 (RFC 4648), as authenticator apps take it. Web Crypto only, since a Convex component
 * has no Node built-ins.
 */

/** The step authenticator apps use, and RFC 6238's default. */
export const TOTP_STEP_SECONDS = 30;

/** The secret is not base32. Never carries the secret itself. */
export class InvalidTotpSecret extends Data.TaggedError("InvalidTotpSecret")<{ readonly reason: string }> {
  override get message(): string {
    return `the authenticator secret is not valid base32: ${this.reason}`;
  }
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decodes base32 as authenticator apps write it: case-insensitive, spaces and `-` ignored, `=` padding optional.
 * Trailing bits that don't fill a byte are dropped, as RFC 4648 decoders do.
 */
export function decodeBase32(text: string): Effect.Effect<Uint8Array<ArrayBuffer>, InvalidTotpSecret> {
  return Effect.suspend(() => {
    const cleaned = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
    if (cleaned.length === 0) return Effect.fail(new InvalidTotpSecret({ reason: "it is empty" }));
    const bytes: Array<number> = [];
    let buffer = 0;
    let bits = 0;
    for (const [index, character] of [...cleaned].entries()) {
      const value = BASE32_ALPHABET.indexOf(character);
      if (value === -1) return Effect.fail(new InvalidTotpSecret({ reason: `character ${index + 1} is outside A-Z and 2-7` }));
      buffer = (buffer << 5) | value;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >>> bits) & 0xff);
      }
    }
    return Effect.succeed(Uint8Array.from(bytes));
  });
}

/** The 8-byte big-endian counter HOTP signs. Split in two 32-bit halves, since bitwise operators truncate to 32 bits. */
function counterBytes(counter: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  return bytes;
}

/** The code for `key` at `unixSeconds`: RFC 6238 with HMAC-SHA-1 and T0 = 0. */
export function totpCode(input: {
  readonly key: Uint8Array<ArrayBuffer>;
  readonly unixSeconds: number;
  readonly digits: number;
}): Effect.Effect<string> {
  const counter = Math.floor(input.unixSeconds / TOTP_STEP_SECONDS);
  return Effect.promise(async () => {
    const hmacKey = await crypto.subtle.importKey("raw", input.key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, counterBytes(counter)));
    const offset = mac[mac.length - 1]! & 0x0f;
    const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
    return (binary % 10 ** input.digits).toString().padStart(input.digits, "0");
  });
}
