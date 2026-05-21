import { HttpException, ServiceUnavailableException } from '@nestjs/common';

/**
 * Build an `HttpException` from an upstream (third-party) failure.
 *
 * Every upstream failure — whether the third party is unreachable
 * (no HTTP response) or responded with a non-success status — collapses
 * to a **503 Service Unavailable** with a generic message of the form
 * `"<upstream> is misconfigured or unavailable"`.
 *
 * The upstream's own status code, response body, and error message are
 * intentionally *not* surfaced to the API caller: those details are an
 * operator concern (logs / metrics) and would leak third-party
 * implementation details to clients who can't act on them. Upstream
 * 4xx in particular must never become a 4xx to the caller — the caller
 * didn't construct the upstream request, we did, so it's our problem.
 *
 * Callers should log the original `error` themselves at `warn` / `error`
 * before throwing, if upstream diagnostics are needed for operators.
 *
 * @param upstream - human-readable name of the third party (e.g.
 *  `'Vault'`, `'AlgodNode'`). Surfaced in the exception message so
 *  operators can grep logs by upstream.
 * @param _error - the original axios / fetch error. Currently ignored
 *  for message construction; kept in the signature so call sites don't
 *  have to change and so future telemetry can hook here.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function mapUpstreamError(upstream: string, _error: unknown): HttpException {
  return new ServiceUnavailableException(`${upstream} is misconfigured or unavailable`);
}
