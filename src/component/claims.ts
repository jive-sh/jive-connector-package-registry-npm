import type { TrustedPublisherClaims } from "./validators";

/**
 * Whether two trusted publishers admit the same workflow. GitHub owner and repository names are
 * case-insensitive; the workflow file and environment are compared exactly, and an absent environment differs
 * from any named one, since it admits every job.
 */
export function sameClaims(a: TrustedPublisherClaims, b: TrustedPublisherClaims): boolean {
  return a.provider === b.provider
    && a.repository.owner.toLowerCase() === b.repository.owner.toLowerCase()
    && a.repository.name.toLowerCase() === b.repository.name.toLowerCase()
    && a.workflowFile === b.workflowFile
    && a.environment === b.environment;
}
