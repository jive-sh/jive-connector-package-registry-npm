import { v, type Infer } from "convex/values";

/**
 * The validators of `packageRegistry`'s functions, which make their generated types the ones
 * `PackageRegistryComponentApi` (jive-abstract-connector-package-registry) names; the build checks they still do.
 */

/** The account an operation acts as: a token from that person's own npm login. */
export const account = v.object({ token: v.string() });
export type Account = Infer<typeof account>;

export const trustedPublisherClaims = v.object({
  provider: v.literal("github"),
  repository: v.object({ owner: v.string(), name: v.string() }),
  workflowFile: v.string(),
  environment: v.optional(v.string()),
});
export type TrustedPublisherClaims = Infer<typeof trustedPublisherClaims>;

export const trustedPublisher = v.object({ id: v.string(), claims: trustedPublisherClaims });
export type TrustedPublisher = Infer<typeof trustedPublisher>;

const secondFactorRequired = v.object({
  status: v.literal("secondFactorRequired"),
  approval: v.optional(v.object({ pageUrl: v.string(), resultUrl: v.string() })),
});
export type SecondFactorRequiredResult = Infer<typeof secondFactorRequired>;

export const createPlaceholderResult = v.union(
  v.object({ status: v.literal("created"), version: v.string() }),
  v.object({ status: v.literal("alreadyExists") }),
  secondFactorRequired,
);
export type CreatePlaceholderResult = Infer<typeof createPlaceholderResult>;

export const registerTrustedPublisherResult = v.union(
  v.object({ status: v.literal("registered") }),
  v.object({ status: v.literal("alreadyRegistered"), id: v.string() }),
  secondFactorRequired,
);
export type RegisterTrustedPublisherResult = Infer<typeof registerTrustedPublisherResult>;
