import semver from "semver";

/** A validated npm package name plus an optional semver range. */
export interface PackageSpec {
  name: string;
  range?: string;
}

/** An entry from the administrator-controlled allowlist. */
export interface AllowlistEntry extends PackageSpec {}

export class PluginSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSpecError";
  }
}

// npm package names: lowercase alphanumerics, dots, dashes and underscores,
// optionally scoped. Deliberately excludes URLs, paths and tarball filenames.
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const UNSAFE_PREFIX =
  /^(?:[./~]|[a-z][a-z0-9+.-]*:|git@|github:|gitlab:|bitbucket:|npm:)/i;
const TARBALL_SUFFIX = /\.(?:tgz|tar\.gz|tar|zip)$/i;

function assertPackageName(name: string, original: string): void {
  if (!PACKAGE_NAME.test(name)) {
    throw new PluginSpecError(
      `Invalid plugin package name "${original}". Only plain npm registry package names are accepted (no paths, URLs, Git refs or tarballs).`,
    );
  }
}

/** Parse and strictly validate a package specification such as `pkg@^1.2.0`. */
export function parsePackageSpec(input: string): PackageSpec {
  if (typeof input !== "string" || input.trim() === "") {
    throw new PluginSpecError("Plugin specification must be a non-empty string.");
  }

  const value = input.trim();
  if (UNSAFE_PREFIX.test(value) || TARBALL_SUFFIX.test(value) || value.includes("://")) {
    throw new PluginSpecError(
      `Plugin specification "${value}" is not a registry package name. Git URLs, local paths, tarballs and custom registry URLs are rejected.`,
    );
  }

  // The last '@' separates the name from the range; scoped names contain one
  // earlier '@'. A leading '@' is part of a scope, never a version separator.
  const separator = value.lastIndexOf("@");
  const hasRange = separator > 0;
  const name = hasRange ? value.slice(0, separator) : value;
  const range = hasRange ? value.slice(separator + 1) : undefined;

  assertPackageName(name, value);

  if (range !== undefined) {
    if (range === "" || semver.validRange(range) === null) {
      throw new PluginSpecError(
        `Invalid version range "${range}" for plugin "${name}". Use a semver range (for example "1.2.3" or "^1.2.0"); dist-tags are not accepted.`,
      );
    }
    return { name, range };
  }
  return { name };
}

/** Stable string form used for cache keys and error messages. */
export function formatPackageSpec(spec: PackageSpec): string {
  return spec.range === undefined ? spec.name : `${spec.name}@${spec.range}`;
}

/**
 * Parse the allowlist. Accepts an array or a comma-separated string.
 * Version constraints inside one entry must use space-separated comparators
 * (e.g. `>=1.2.0 <2.0.0`) so commas can separate entries.
 */
export function parseAllowlist(input: string | readonly string[] | undefined): AllowlistEntry[] {
  if (input === undefined || input === null || input === "") return [];

  const entries = typeof input === "string" ? input.split(",") : [...input];
  return entries
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => parsePackageSpec(entry));
}

export class PluginNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginNotAllowedError";
  }
}

/**
 * Authorize a request-supplied spec against the allowlist and return the spec
 * that should actually be installed. An allowed version constraint is applied
 * when the request itself is unpinned, so admins control resolution too.
 */
export function authorizeSpec(
  requested: PackageSpec,
  allowlist: readonly AllowlistEntry[],
): PackageSpec {
  const allowed = allowlist.find((entry) => entry.name.toLowerCase() === requested.name.toLowerCase());
  if (allowed === undefined) {
    throw new PluginNotAllowedError(
      `Plugin "${formatPackageSpec(requested)}" is not in PRETTIER_PLUGIN_ALLOWLIST.`,
    );
  }

  if (allowed.range !== undefined) {
    if (requested.range === undefined) {
      return { name: requested.name, range: allowed.range };
    }
    if (!semver.subset(requested.range, allowed.range, { includePrerelease: true })) {
      throw new PluginNotAllowedError(
        `Plugin version "${formatPackageSpec(requested)}" is outside the allowed range "${formatPackageSpec(allowed)}".`,
      );
    }
  }

  return requested;
}
