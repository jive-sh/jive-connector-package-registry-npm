import { Effect } from "effect";
import { gzipSync } from "fflate";

/**
 * An npm package tarball built without Node built-ins, which a Convex component lacks: a ustar archive of
 * `package/<path>` entries, gzipped by fflate (Convex's runtime has no `CompressionStream`), plus the digests npm
 * records for it.
 */

export interface PackedTarball {
  readonly bytes: Uint8Array;
  /** `sha512-<base64>`, npm's `dist.integrity`. */
  readonly integrity: string;
  /** Hex SHA-1, npm's legacy `dist.shasum`. */
  readonly shasum: string;
}

const BLOCK = 512;
const encoder = new TextEncoder();

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(path: string, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (offset: number, text: string) => block.set(encoder.encode(text), offset);
  put(0, path);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  // A fixed time, so the tarball depends only on its contents.
  put(136, octal(499162500, 12));
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  put(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** The uncompressed archive: each file's header and contents padded to a block, then two empty blocks. */
export function tarArchive(files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Uint8Array<ArrayBuffer> {
  const parts: Array<Uint8Array> = [];
  for (const file of files) {
    const contents = encoder.encode(file.text);
    parts.push(header(`package/${file.path}`, contents.length), contents);
    const padding = (BLOCK - (contents.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const archive = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.length;
  }
  return archive;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Gzips the archive and digests the result. */
export function packTarball(files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Effect.Effect<PackedTarball> {
  return Effect.promise(async () => {
    const bytes = gzipSync(tarArchive(files), { mtime: 0 });
    const sha512 = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
    const sha1 = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
    return { bytes, integrity: `sha512-${toBase64(sha512)}`, shasum: toHex(sha1) };
  });
}
