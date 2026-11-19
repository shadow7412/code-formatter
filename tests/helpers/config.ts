import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../../src/config.js";
import { parseAllowlist } from "../../src/spec.js";

export async function makeConfig(
  registry: string,
  overrides: Partial<ServerConfig> = {},
): Promise<ServerConfig> {
  const cacheDir = await mkdtemp(join(tmpdir(), "prettier-plugin-cache-"));
  return {
    autoInstall: true,
    allowlist: parseAllowlist("test-plugin,lifecycle-plugin"),
    cacheDir,
    installTimeoutMs: 10_000,
    blackCommand: "black",
    blackTimeoutMs: 10_000,
    registry,
    maxMemoryMb: 4096,
    maxCpuSeconds: 60,
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 3072,
    httpPath: "/mcp",
    httpAllowUnauthenticated: false,
    ...overrides,
  };
}
