/**
 * A request URL with the value of every credential-bearing query parameter
 * masked, for the request log. OAuth flows carry single-use secrets on the query
 * string (`?cap=`, `?code=`, `?state=`, `?token=`), and an artifact page carries
 * its per-artifact key as `?key=`; logged verbatim, any of them is a live
 * credential in Pino, Sentry and a debug log a user may paste into a report. Only
 * the VALUE is masked.
 *
 * Applied wherever a request URL is written out: the request log line and the
 * request data the logger attaches to it. A separate module so the request
 * context can use it without importing the setup that imports the context.
 */
export const redactSecretQueries = (url: string): string =>
  url.replace(
    /([?&](?:cap|code|key|state|token|access_token|refresh_token)=)[^&]*/gi,
    '$1[REDACTED]',
  );
