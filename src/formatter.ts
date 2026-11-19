import * as prettier from "prettier";
import type { PluginManager } from "./plugin-manager.js";
import {
  BLACK_EXTENSIONS,
  BlackConfigError,
  isPythonTarget,
  type BlackRunner,
} from "./python.js";
import { PluginSpecError } from "./spec.js";

export interface FormatRequest {
  filename: string;
  code: string;
  config?: unknown;
  plugins?: string[];
}

export interface FormatResult {
  formatted: string;
  plugins: string[];
}

export class FormatRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatRequestError";
  }
}

export class FormattingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FormattingError";
  }
}

export interface SupportedLanguage {
  name: string;
  extensions: string[];
  filenames: string[];
  parsers: string[];
}

export interface FormatterInfo {
  name: string;
  version: string;
  extensions: string[];
}

export interface SupportResult {
  prettierVersion: string;
  extensions: string[];
  languages: SupportedLanguage[];
  plugins: string[];
  formatters: FormatterInfo[];
}

/** Report the file types this server can format, including optional plugins. */
export async function describeSupport(
  plugins: PluginManager,
  requestedSpecs: readonly string[] = [],
  black?: BlackRunner,
): Promise<SupportResult> {
  const loaded =
    requestedSpecs.length > 0
      ? await plugins.loadPlugins(requestedSpecs)
      : { plugins: [], specs: [] };

  const info = await prettier.getSupportInfo({
    plugins: loaded.plugins as prettier.Plugin[],
  });

  const languages: SupportedLanguage[] = info.languages
    .map((language) => ({
      name: language.name,
      extensions: [...(language.extensions ?? [])].sort(),
      filenames: [...(language.filenames ?? [])].sort(),
      parsers: [...language.parsers].sort(),
    }))
    .filter((language) => language.extensions.length > 0 || language.filenames.length > 0);

  const prettierExtensions = new Set(languages.flatMap((language) => language.extensions));
  const formatters: FormatterInfo[] = [
    {
      name: "prettier",
      version: prettier.version,
      extensions: [...prettierExtensions].sort(),
    },
  ];

  const blackVersion = black === undefined ? undefined : await black.version();
  if (blackVersion !== undefined) {
    languages.push({
      name: "Python (Black)",
      extensions: [...BLACK_EXTENSIONS],
      filenames: [],
      parsers: ["black"],
    });
    formatters.push({
      name: "black",
      version: blackVersion,
      extensions: [...BLACK_EXTENSIONS],
    });
  }

  languages.sort((left, right) => left.name.localeCompare(right.name));

  return {
    prettierVersion: prettier.version,
    extensions: [...new Set(languages.flatMap((language) => language.extensions))].sort(),
    languages,
    plugins: loaded.specs,
    formatters,
  };
}

function parseConfig(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch (cause) {
      throw new FormatRequestError(`config must be valid JSON: ${String(cause)}`);
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FormatRequestError("config must be a JSON object or a JSON string containing one.");
  }
  return value as Record<string, unknown>;
}

/**
 * Plugins may be requested explicitly or declared by the supplied Prettier
 * config. Nothing is ever inferred from the filename.
 */
export function discoverPluginSpecs(request: FormatRequest, config: Record<string, unknown>): string[] {
  const specs: string[] = [];

  if (request.plugins !== undefined) {
    for (const spec of request.plugins) {
      if (typeof spec !== "string") {
        throw new FormatRequestError("Every entry in plugins must be a package name string.");
      }
      specs.push(spec);
    }
  }

  const declared = config.plugins;
  if (declared !== undefined) {
    const entries = Array.isArray(declared) ? declared : [declared];
    for (const entry of entries) {
      if (typeof entry === "string") {
        specs.push(entry);
      } else if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string"
      ) {
        specs.push((entry as { name: string }).name);
      } else {
        throw new FormatRequestError(
          "config.plugins entries must be registry package names (or objects with a name); local paths and inline plugin objects cannot be installed.",
        );
      }
    }
  }

  return [...new Set(specs)];
}

function hasRequestedPlugins(request: FormatRequest, config: Record<string, unknown>): boolean {
  if (request.plugins !== undefined && request.plugins.length > 0) return true;
  if (config.plugins === undefined) return false;
  return !Array.isArray(config.plugins) || config.plugins.length > 0;
}

function formatWithBlack(
  request: FormatRequest,
  config: Record<string, unknown>,
  black: BlackRunner | undefined,
): Promise<FormatResult> {
  if (hasRequestedPlugins(request, config)) {
    throw new FormatRequestError(
      "Prettier plugins cannot be applied to Python files formatted with Black.",
    );
  }
  if (black === undefined) {
    throw new FormatRequestError("Python formatting is unavailable because BLACK_BIN is not configured.");
  }
  return black
    .format(request.filename, request.code, config)
    .then((formatted) => ({ formatted, plugins: [] }))
    .catch((cause: unknown) => {
      if (cause instanceof BlackConfigError || cause instanceof FormatRequestError) throw cause;
      throw new FormattingError(
        `Black could not format ${request.filename}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    });
}

export async function formatCode(
  request: FormatRequest,
  plugins: PluginManager,
  black?: BlackRunner,
): Promise<FormatResult> {
  const config = parseConfig(request.config);

  if (isPythonTarget(request.filename, config)) {
    return formatWithBlack(request, config, black);
  }

  const requestedSpecs = discoverPluginSpecs(request, config);

  let loaded: { plugins: unknown[]; specs: string[] } = { plugins: [], specs: [] };
  if (requestedSpecs.length > 0) {
    loaded = await plugins.loadPlugins(requestedSpecs);
  }

  const { plugins: _declared, black: _black, filepath: _filepath, ...rest } = config;
  const options: prettier.Options = {
    ...rest,
    filepath: request.filename,
    plugins: loaded.plugins as prettier.Plugin[],
  };

  try {
    const formatted = await prettier.format(request.code, options);
    return { formatted, plugins: loaded.specs };
  } catch (cause) {
    if (cause instanceof PluginSpecError) throw cause;
    throw new FormattingError(
      `Prettier could not format ${request.filename}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
