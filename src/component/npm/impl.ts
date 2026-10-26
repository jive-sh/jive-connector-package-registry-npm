import { Effect, Layer, Option, Schema, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import type { TrustedPublisher, TrustedPublisherClaims } from "../validators";
import { NpmRegistry, RegistryRequestFailed, SecondFactorRequired, type AsAccount, type INpmRegistry } from "./interface";
import { packTarball, toBase64 } from "./tarball";

/**
 * Wire formats and endpoints are npm 12.2.1's, read from its source, since npm documents no HTTP API for
 * publishing or trusted publishers: `libnpmpublish` (publish), `lib/commands/trust/*.js` (trust), and
 * `npm-registry-fetch`'s `check-response.js` (how npm asks for the second factor).
 */

/** Abbreviated package metadata: what `npm install` asks for, a fraction of the full document. */
const ABBREVIATED_METADATA = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

/** What `npm trust github --allow-publish` grants. */
const PUBLISH_PERMISSION = "createPackage";

const TrustConfigs = Schema.Array(Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  claims: Schema.Struct({
    repository: Schema.optionalKey(Schema.String),
    workflow_ref: Schema.optionalKey(Schema.Struct({ file: Schema.String })),
    environment: Schema.optionalKey(Schema.String),
  }),
}));

/** The body of npm's second-factor 401 when it offers approval in a browser. */
const WebApproval = Schema.fromJsonString(Schema.Struct({ authUrl: Schema.String, doneUrl: Schema.String }));

/** `@scope/name` → `@scope%2fname`, as npm-package-arg's `escapedName`. */
function escapedName(packageName: string): string {
  return packageName.replace("/", "%2f");
}

class NpmRegistryImpl implements INpmRegistry {
  constructor(
    private readonly client: HttpClient.HttpClient,
    /** e.g. "https://registry.npmjs.org", without a trailing slash. */
    private readonly registryUrl: string,
  ) {}

  *packageExists(packageName: string): Effect.fn.Return<boolean, RegistryRequestFailed> {
    const operation = `check whether ${packageName} exists`;
    const response = yield* this.send(operation, pipe(
      HttpClientRequest.get(`${this.registryUrl}/${escapedName(packageName)}`),
      HttpClientRequest.setHeader("accept", ABBREVIATED_METADATA),
    ));
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    return yield* this.failed(operation, response);
  }

  *publishPlaceholder(input: AsAccount & { readonly version: string; readonly description: string }): Effect.fn.Return<
    void,
    RegistryRequestFailed | SecondFactorRequired
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
    const request = this.asAccount(
      HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.put(`${this.registryUrl}/${escapedName(name)}`), document),
      input,
    );
    const response = yield* this.send(operation, request);
    if (response.status < 200 || response.status >= 300) return yield* this.refused(operation, response);
  }

  *listTrustedPublishers(input: AsAccount): Effect.fn.Return<
    ReadonlyArray<TrustedPublisher>,
    RegistryRequestFailed | SecondFactorRequired
  > {
    const operation = `list the trusted publishers of ${input.packageName}`;
    const response = yield* this.send(operation, this.asAccount(HttpClientRequest.get(this.trustUrl(input.packageName)), input));
    if (response.status !== 200) return yield* this.refused(operation, response);

    const configs = yield* pipe(
      response.json,
      Effect.flatMap(Schema.decodeUnknownEffect(TrustConfigs)),
      Effect.mapError((e) => new RegistryRequestFailed({ operation, detail: `unexpected response: ${e.message}` })),
    );
    return configs.flatMap((config): ReadonlyArray<TrustedPublisher> => {
      const [owner, name, ...rest] = (config.claims.repository ?? "").split("/");
      const workflowFile = config.claims.workflow_ref?.file;
      if (config.type !== "github" || !owner || !name || rest.length > 0 || workflowFile === undefined) return [];
      const environment = config.claims.environment;
      return [{
        id: config.id,
        claims: { provider: "github", repository: { owner, name }, workflowFile, ...(environment === undefined ? {} : { environment }) },
      }];
    });
  }

  *addTrustedPublisher(input: AsAccount & { readonly claims: TrustedPublisherClaims }): Effect.fn.Return<
    void,
    RegistryRequestFailed | SecondFactorRequired
  > {
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
    const request = this.asAccount(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(this.trustUrl(input.packageName)), body), input);
    const response = yield* this.send(operation, request);
    if (response.status < 200 || response.status >= 300) return yield* this.refused(operation, response);
  }

  private trustUrl(packageName: string): string {
    return `${this.registryUrl}/-/package/${escapedName(packageName)}/trust`;
  }

  /**
   * Authenticates a request as the account, with its one-time password when the caller has one. `npm-auth-type:
   * web` is what npm's CLI sends (npm-registry-fetch `getHeaders`), so the registry answers this client as it
   * answers the CLI when it wants the second factor.
   */
  private asAccount(request: HttpClientRequest.HttpClientRequest, input: AsAccount): HttpClientRequest.HttpClientRequest {
    const authenticated = pipe(
      HttpClientRequest.bearerToken(request, input.account.token),
      HttpClientRequest.setHeader("npm-auth-type", "web"),
    );
    return Option.match(input.oneTimePassword, {
      onNone: () => authenticated,
      onSome: (otp) => HttpClientRequest.setHeader(authenticated, "npm-otp", otp),
    });
  }

  private *send(
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.fn.Return<HttpClientResponse.HttpClientResponse, RegistryRequestFailed> {
    return yield* pipe(
      this.client.execute(request),
      Effect.mapError((e) => new RegistryRequestFailed({ operation, detail: e.message })),
    );
  }

  /**
   * A refusal that may be npm asking for the second factor: a 401 whose `www-authenticate` lists `otp`, or whose
   * body mentions a one-time password, as `check-response.js` treats both.
   */
  private *refused(
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.fn.Return<never, RegistryRequestFailed | SecondFactorRequired> {
    const text = yield* pipe(response.text, Effect.orElseSucceed(() => ""));
    const challenges = (response.headers["www-authenticate"] ?? "").split(/,\s*/).map((part) => part.toLowerCase());
    if (response.status === 401 && (challenges.includes("otp") || /one-time pass/.test(text))) {
      const approval = yield* pipe(
        Schema.decodeUnknownEffect(WebApproval)(text),
        Effect.map(({ authUrl, doneUrl }) => Option.some({ pageUrl: authUrl, resultUrl: doneUrl })),
        Effect.orElseSucceed(() => Option.none()),
      );
      return yield* new SecondFactorRequired({ approval });
    }
    return yield* new RegistryRequestFailed({ operation, detail: `it answered ${response.status}: ${text.slice(0, 500)}` });
  }

  private *failed(operation: string, response: HttpClientResponse.HttpClientResponse): Effect.fn.Return<never, RegistryRequestFailed> {
    const text = yield* pipe(response.text, Effect.orElseSucceed(() => ""));
    return yield* new RegistryRequestFailed({ operation, detail: `it answered ${response.status}: ${text.slice(0, 500)}` });
  }
}

/** The registry at `registryUrl`, over `fetch`, which is all a Convex component's runtime offers. */
export function npmRegistryLayer(registryUrl: string): Layer.Layer<NpmRegistry> {
  return pipe(
    Layer.effect(NpmRegistry, Effect.gen(function* () {
      return new NpmRegistryImpl(yield* HttpClient.HttpClient, registryUrl.replace(/\/+$/, ""));
    })),
    Layer.provide(FetchHttpClient.layer),
  );
}
