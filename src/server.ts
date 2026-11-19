import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, sanitizeProcessEnv, type ServerConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { buildMcpServer } from "./mcp-server.js";
import { PluginManager } from "./plugin-manager.js";
import { BlackFormatter, type BlackRunner } from "./python.js";

export function createServer(
  options: { config?: ServerConfig; plugins?: PluginManager; black?: BlackRunner } = {},
) {
  let config: ServerConfig;
  if (options.config !== undefined) {
    config = options.config;
  } else {
    try {
      config = loadConfig();
    } catch (cause) {
      throw new Error(`Invalid configuration: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  }

  // Do this before any plugin can run, but after reading auth configuration:
  // plugins share this process and can inspect process.env.
  sanitizeProcessEnv();

  const plugins = options.plugins ?? new PluginManager({ config });
  const black = options.black ?? new BlackFormatter(config.blackCommand, config.blackTimeoutMs);
  const createMcpServer = () => buildMcpServer(config, plugins, black);

  return { server: createMcpServer(), createMcpServer, plugins, black, config };
}

async function main(): Promise<void> {
  const { server, createMcpServer, config } = createServer();
  if (config.transport === "http") {
    // The stdio-shaped server is unused in HTTP mode; each HTTP request gets a
    // fresh MCP server and transport as required by the SDK's stateless mode.
    await server.close();
    const httpServer = await startHttpServer(config, createMcpServer);
    console.error(
      `MCP server listening on http://${config.httpHost}:${config.httpPort}${config.httpPath}`,
    );
    const shutdown = () => {
      httpServer.close();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    return;
  }

  await server.connect(new StdioServerTransport());
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
    process.exitCode = 1;
  });
}
