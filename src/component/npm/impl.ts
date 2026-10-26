import { Effect, Layer, Option, Schema, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { SecondFactor, type ISecondFactor } from "../secondFactor/interface";
import type { Account, TrustedPublisher, TrustedPublisherClaims } from "../validators";
import { NpmRegistry, RegistryRequestFailed, type AccountOperationError, type AsAccount, type INpmRegistry } from "./interface";
import { packTarball, toBase64 } from "./tarball";

/**
 * Wire formats and endpoints are npm's, read from its source, since npm documents no HTTP API for publishing or
 * trusted publishers: `libnpmpublish` (publish), `lib/commands/trust/*.js` (trust, including `revoke`'s DELETE),
 * `lib/utils/get-identity.js` (`/-/whoami`), `lib/commands/owner.js` (maintainers) and `npm-registry-fetch`'s
 * `check-response.js` (how npm asks for the second factor).
 */

/** Abbreviated package metadata: what `npm install` asks for, a fraction of the full document. */
const ABBREVIATED_METADATA = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

/** What `npm trust github --allow-publish` grants. */
const PUBLISH_PERMISSION = "createPackage";

const TrustConfigs = Schema.fromJsonString(Schema.Array(Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  claims: Schema.Struct({
    repository: Schema.optionalKey(Schema.String),
    workflow_ref: Schema.optionalKey(Schema.Struct({ file: Schema.String })),
    environment: Schema.optionalKey(Schema.String),
  }),
})));

/**
 * The parts of the full package document this module reads. A version published through trusted publishing
 * names the configuration that published it in `_npmUser.trustedPublisher.oidcConfigId` (seen on
 * effective-modules' packument, 2026-10-26). That this id is the one the trust API lists is my inference: npm
 * documents neither field.
 */
const Packument = Schema.fromJsonString(Schema.Struct({
  maintainers: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
  versions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
    _npmUser: Schema.optionalKey(Schema.Struct({
      trustedPublisher: Schema.optionalKey(Schema.Struct({ oidcConfigId: Schema.optionalKey(Schema.String) })),
    })),
  }))),
}));
type Packument = typeof Packument.Type;

const Whoami = Schema.fromJsonString(Schema.Struct({ username: Schema.String }));

/** One registry response, its body read once, so detecting the second-factor challenge doesn't consume it. */
interface RegistryAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}

/** `@scope/name` → `@scope%2fname`, as npm-package-arg's `escapedName`. */
function escapedName(packageName: string): string {
  return packageName.replace("/", "%2f");
}

function succeeded(answer: RegistryAnswer): boolean {
  return answer.status >= 200 && answer.status < 300;
}

/** npm wants a one-time password: a 401 whose `www-authenticate` lists `otp`, or whose body mentions one, as `check-response.js` treats both. */
function asksForSecondFactor(answer: RegistryAnswer): boolean {
  const challenges = (answer.headers["www-authenticate"] ?? "").split(/,\s*/).map((part) => part.toLowerCase());
  return answer.status === 401 && (challenges.includes("otp") || /one-time pass/.test(answer.text));
}

/** The field names across the configurations in a trust-list body, sorted; none when it is not a JSON array. */
function trustConfigFieldNames(text: string): ReadonlyArray<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const names = new Set(parsed.flatMap((config: unknown) => typeof config === "object" && config !== null ? Object.keys(config) : []));
  return [...names].sort();
}

class NpmRegistryImpl implements INpmRegistry {
  constructor(
    private readonly client: HttpClient.HttpClient,
    private readonly secondFactor: ISecondFactor,
    /** e.g. "https://registry.npmjs.org", without a trailing slash. */
    private readonly registryUrl: string,
  ) {}

  *packageExists(packageName: string): Effect.fn.Return<boolean, RegistryRequestFailed> {
    const operation = `check whether ${packageName} exists`;
    const answer = yield* this.send(operation, pipe(
      HttpClientRequest.get(this.packageUrl(packageName)),
      HttpClientRequest.setHeader("accept", ABBREVIATED_METADATA),
    ));
    if (answer.status === 200) return true;
    if (answer.status === 404) return false;
    return yield* this.unexpected(operation, answer);
  }

  *maintainers(packageName: string): Effect.fn.Return<Option.Option<ReadonlyArray<string>>, RegistryRequestFailed> {
    const maybePackument = yield* this.packument(`read the maintainers of ${packageName}`, packageName);
    return Option.map(maybePackument, (packument) => (packument.maintainers ?? []).map((maintainer) => maintainer.name));
  }

  *username(account: Account): Effect.fn.Return<string, RegistryRequestFailed> {
    const operation = "find which npm account the token belongs to";
    const answer = yield* this.send(operation, this.authenticated(HttpClientRequest.get(`${this.registryUrl}/-/whoami`), account));
    if (answer.status !== 200) return yield* this.unexpected(operation, answer);
    const { username } = yield* this.decode(operation, Whoami, answer);
    return username;
  }

  *publishPlaceholder(input: AsAccount & { readonly version: string; readonly description: string }): Effect.fn.Return<
    void,
    AccountOperationError
  > {
    const { packageName: name, version, description } = input;
    const operation = `publish ${name}@${version}`;
    const manifest = { name, version, description };
    const tarball = yield* packTarball([{ path: "package.json", text: `${JSON.stringify(manifest, null, 2)}\n` }]);
    // The document libnpmpublish's buildMetadata sends for `npm publish`.
    const tarballName = `${name}-${version}.tgz`;
    const document = {
      _id: name,
      name,
      description,
      "dist-tags": { latest: version },
      versions: {
        [version]: {
          ...manifest,
          _id: `${name}@${version}`,
          dist: { integrity: tarball.integrity, shasum: tarball.shasum, tarball: `${this.registryUrl}/${name}/-/${tarballName}` },
        },
      },
      access: name.startsWith("@") ? "public" : null,
      _attachments: {
        [tarballName]: { content_type: "application/octet-stream", data: toBase64(tarball.bytes), length: tarball.bytes.length },
      },
    };
    const request = HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.put(this.packageUrl(name)), document);
    const answer = yield* this.sendAsAccount(operation, request, input.account);
    if (!succeeded(answer)) return yield* this.unexpected(operation, answer);
  }

  *listTrustedPublishers(input: AsAccount): Effect.fn.Return<ReadonlyArray<TrustedPublisher>, AccountOperationError> {
    const operation = `list the trusted publishers of ${input.packageName}`;
    const answer = yield* this.sendAsAccount(operation, HttpClientRequest.get(this.trustUrl(input.packageName)), input.account);
    if (answer.status !== 200) return yield* this.unexpected(operation, answer);
    yield* this.logTrustConfigFields(answer);
    const configs = yield* this.decode(operation, TrustConfigs, answer);
    const published = yield* this.publishingConfigurations(input.packageName);

    return configs.flatMap((config): ReadonlyArray<TrustedPublisher> => {
      const [owner, name, ...rest] = (config.claims.repository ?? "").split("/");
      const workflowFile = config.claims.workflow_ref?.file;
      if (config.type !== "github" || !owner || !name || rest.length > 0 || workflowFile === undefined) return [];
      const environment = config.claims.environment;
      return [{
        id: config.id,
        claims: { provider: "github", repository: { owner, name }, workflowFile, ...(environment === undefined ? {} : { environment }) },
        status: published.has(config.id) ? "validated" : "unvalidated",
      }];
    });
  }

  *addTrustedPublisher(input: AsAccount & { readonly claims: TrustedPublisherClaims }): Effect.fn.Return<void, AccountOperationError> {
    const operation = `add a trusted publisher to ${input.packageName}`;
    const { repository, workflowFile, environment } = input.claims;
    // The body `npm trust github` sends: an array of one configuration.
    const body = [{
      type: "github",
      claims: {
        repository: `${repository.owner}/${repository.name}`,
        workflow_ref: { file: workflowFile },
        ...(environment === undefined ? {} : { environment }),
      },
      permissions: [PUBLISH_PERMISSION],
    }];
    const request = HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(this.trustUrl(input.packageName)), body);
    const answer = yield* this.sendAsAccount(operation, request, input.account);
    if (!succeeded(answer)) return yield* this.unexpected(operation, answer);
  }

  *removeTrustedPublisher(input: AsAccount & { readonly id: string }): Effect.fn.Return<boolean, AccountOperationError> {
    const operation = `remove trusted publisher ${input.id} from ${input.packageName}`;
    const request = HttpClientRequest.delete(`${this.trustUrl(input.packageName)}/${encodeURIComponent(input.id)}`);
    const answer = yield* this.sendAsAccount(operation, request, input.account);
    if (answer.status === 404) return false;
    if (!succeeded(answer)) return yield* this.unexpected(operation, answer);
    return true;
  }

  private packageUrl(packageName: string): string {
    return `${this.registryUrl}/${escapedName(packageName)}`;
  }

  private trustUrl(packageName: string): string {
    return `${this.registryUrl}/-/package/${escapedName(packageName)}/trust`;
  }

  /** The full package document, or none when the package does not exist. */
  private *packument(operation: string, packageName: string): Effect.fn.Return<Option.Option<Packument>, RegistryRequestFailed> {
    const answer = yield* this.send(operation, pipe(
      HttpClientRequest.get(this.packageUrl(packageName)),
      HttpClientRequest.setHeader("accept", "application/json"),
    ));
    if (answer.status === 404) return Option.none();
    if (answer.status !== 200) return yield* this.unexpected(operation, answer);
    return Option.some(yield* this.decode(operation, Packument, answer));
  }

  /** The ids of the trust configurations that published some version of the package. */
  private *publishingConfigurations(packageName: string): Effect.fn.Return<ReadonlySet<string>, RegistryRequestFailed> {
    const maybePackument = yield* this.packument(`read which publishers published ${packageName}`, packageName);
    const ids = new Set<string>();
    for (const packument of Option.toArray(maybePackument)) {
      for (const version of Object.values(packument.versions ?? {})) {
        const id = version._npmUser?.trustedPublisher?.oidcConfigId;
        if (id !== undefined) ids.add(id);
      }
    }
    return ids;
  }

  /**
   * Logs the field names (never values) npm's trust list returns. npm documents none of them, and whether it marks
   * an expired configuration is unverified; the names show it the first time an account lists a real package.
   */
  private *logTrustConfigFields(answer: RegistryAnswer): Effect.fn.Return<void> {
    yield* Effect.log(`npm trust list fields: ${trustConfigFieldNames(answer.text).join(", ")}`);
  }

  /** Authenticates a request as the account. `npm-auth-type: web` is what npm's CLI sends (npm-registry-fetch `getHeaders`). */
  private authenticated(request: HttpClientRequest.HttpClientRequest, account: Account): HttpClientRequest.HttpClientRequest {
    return pipe(
      HttpClientRequest.bearerToken(request, account.token),
      HttpClientRequest.setHeader("npm-auth-type", "web"),
    );
  }

  /**
   * Sends the request as the account. When npm refuses it for want of a one-time password (its EOTP), sends it
   * once more with the code the account's second factor gives now, as `npm-otp`; a second refusal fails, since a
   * correct current code that npm still refuses will not succeed by retrying.
   */
  private *sendAsAccount(
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    account: Account,
  ): Effect.fn.Return<RegistryAnswer, AccountOperationError> {
    const authenticated = this.authenticated(request, account);
    const first = yield* this.send(operation, authenticated);
    if (!asksForSecondFactor(first)) return first;
    const oneTimePassword = yield* this.secondFactor.oneTimePassword(account.secondFactor);
    const second = yield* this.send(operation, HttpClientRequest.setHeader(authenticated, "npm-otp", oneTimePassword));
    if (asksForSecondFactor(second)) {
      return yield* new RegistryRequestFailed({
        operation,
        detail: "npm refused the one-time password computed from the account's authenticator secret (is the secret the one npm's two-factor setup showed, and the server's clock right?)",
      });
    }
    return second;
  }

  private *send(operation: string, request: HttpClientRequest.HttpClientRequest): Effect.fn.Return<RegistryAnswer, RegistryRequestFailed> {
    return yield* pipe(
      this.client.execute(request),
      Effect.flatMap((response) => Effect.map(response.text, (text) => ({ status: response.status, headers: response.headers, text }))),
      Effect.mapError((e) => new RegistryRequestFailed({ operation, detail: e.message })),
    );
  }

  private *decode<A>(operation: string, schema: Schema.Codec<A, string>, answer: RegistryAnswer): Effect.fn.Return<A, RegistryRequestFailed> {
    return yield* pipe(
      Schema.decodeUnknownEffect(schema)(answer.text),
      Effect.mapError((e) => new RegistryRequestFailed({ operation, detail: `unexpected response: ${e.message}` })),
    );
  }

  private *unexpected(operation: string, answer: RegistryAnswer): Effect.fn.Return<never, RegistryRequestFailed> {
    return yield* new RegistryRequestFailed({ operation, detail: `it answered ${answer.status}: ${answer.text.slice(0, 500)}` });
  }
}

/** The registry at `registryUrl`, over `fetch`, which is all a Convex component's runtime offers. */
export function npmRegistryLayer(registryUrl: string): Layer.Layer<NpmRegistry, never, SecondFactor> {
  return pipe(
    Layer.effect(NpmRegistry, Effect.gen(function* () {
      return new NpmRegistryImpl(yield* HttpClient.HttpClient, yield* SecondFactor, registryUrl.replace(/\/+$/, ""));
    })),
    Layer.provide(FetchHttpClient.layer),
  );
}
