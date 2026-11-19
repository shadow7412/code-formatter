import { resolve } from "node:path";
import { parseAllowlist, type AllowlistEntry } from "./spec.js";

export interface ServerConfig {
  autoInstall: boolean;
  allowlist: AllowlistEntry[];
  cacheDir: string;
  installTimeoutMs: number;
  blackCommand: string;
  blackTimeoutMs: number;
  registry: string;
  maxMemoryMb: number;
  maxCpuSeconds: number;
  adminToken?: string;
  transport: "stdio" | "http";
  httpHost: string;
  httpPort: number;
  httpPath: string;
  httpToken?: string;
  httpAllowUnauthenticated: boolean;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function booleanEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new ConfigurationError(`${name} must be a boolean, got "${raw}".`);
}

function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new ConfigurationError(`${name} must be an integer >= ${minimum}, got "${raw}".`);
  }
  return value;
}

function registryEnv(env: NodeJS.ProcessEnv): string {
  const raw = env.PRETTIER_PLUGIN_REGISTRY?.trim();
  if (raw === undefined || raw === "") return "https://registry.npmjs.org/";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(`PRETTIER_PLUGIN_REGISTRY must be a URL, got "${raw}".`);
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigurationError(
      "PRETTIER_PLUGIN_REGISTRY must use https (http is only allowed for localhost).",
    );
  }
  return raw;
}

function transportEnv(env: NodeJS.ProcessEnv): "stdio" | "http" {
  const raw = env.MCP_TRANSPORT?.trim().toLowerCase() || "stdio";
  if (raw !== "stdio" && raw !== "http") {
    throw new ConfigurationError(`MCP_TRANSPORT must be "stdio" or "http", got "${raw}".`);
  }
  return raw;
}

function portEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.MCP_HTTP_PORT?.trim() || "3072";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigurationError(`MCP_HTTP_PORT must be a port number, got "${raw}".`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const cacheDir = resolve(
    env.PRETTIER_PLUGIN_CACHE?.trim() || ".cache/prettier-plugins",
  );
  const transport = transportEnv(env);
  const httpPath = env.MCP_HTTP_PATH?.trim() || "/mcp";
  if (!httpPath.startsWith("/") || httpPath.includes("?") || httpPath.includes("#")) {
    throw new ConfigurationError(`MCP_HTTP_PATH must start with "/" and contain no query or fragment, got "${httpPath}".`);
  }
  const rawHttpToken = env.MCP_HTTP_TOKEN?.trim();
  const httpToken = rawHttpToken === undefined || rawHttpToken === "" ? undefined : rawHttpToken;
  const httpAllowUnauthenticated = booleanEnv(env, "MCP_HTTP_ALLOW_UNAUTHENTICATED", false);
  if (transport === "http") {
    if (httpAllowUnauthenticated && httpToken !== undefined) {
      throw new ConfigurationError(
        "Set either MCP_HTTP_TOKEN or MCP_HTTP_ALLOW_UNAUTHENTICATED=true, not both.",
      );
    }
    if (!httpAllowUnauthenticated && (httpToken === undefined || httpToken.length < 16)) {
      throw new ConfigurationError(
        "MCP_HTTP_TOKEN must be set to at least 16 characters when MCP_TRANSPORT=http, unless MCP_HTTP_ALLOW_UNAUTHENTICATED=true is explicitly set for a private tunnel.",
      );
    }
  }

  const config: ServerConfig = {
    autoInstall: booleanEnv(env, "PRETTIER_PLUGIN_AUTO_INSTALL", true),
    allowlist: parseAllowlist(env.PRETTIER_PLUGIN_ALLOWLIST),
    cacheDir,
    installTimeoutMs: integerEnv(env, "PRETTIER_PLUGIN_INSTALL_TIMEOUT", 30_000, 1),
    blackCommand: env.BLACK_BIN?.trim() || "black",
    blackTimeoutMs: integerEnv(env, "BLACK_TIMEOUT_MS", 30_000, 1),
    registry: registryEnv(env),
    maxMemoryMb: integerEnv(env, "PRETTIER_PLUGIN_MAX_MEMORY_MB", 4096, 256),
    maxCpuSeconds: integerEnv(env, "PRETTIER_PLUGIN_MAX_CPU_SECONDS", 60, 1),
    transport,
    httpHost: env.MCP_HTTP_HOST?.trim() || "0.0.0.0",
    httpPort: portEnv(env),
    httpPath,
    httpAllowUnauthenticated,
  };
  const adminToken = env.PRETTIER_ADMIN_TOKEN?.trim();
  if (adminToken !== undefined && adminToken !== "") config.adminToken = adminToken;
  if (httpToken !== undefined) config.httpToken = httpToken;
  return config;
}

const CREDENTIAL_KEY =
  /(?:token|password|passwd|secret|credential|api[_-]?key|private[_-]?key|session|cookie|authorization|npm_config__auth)/i;

/**
 * Plugin code runs in this process. Strip credential-shaped environment
 * variables at startup so a plugin cannot exfiltrate them from process.env.
 */
export function sanitizeProcessEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_KEY.test(key) || key.startsWith("AWS_") || key.startsWith("npm_config_")) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}
