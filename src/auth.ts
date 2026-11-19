import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export function tokensMatch(provided: string, expected: string): boolean {
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Extract a bearer credential from an HTTP Authorization header. */
export function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1];
}

export function isAuthorized(headers: IncomingHttpHeaders, token: string): boolean {
  const provided = bearerToken(headers);
  return provided !== undefined && tokensMatch(provided, token);
}
