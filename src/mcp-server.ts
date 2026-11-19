import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tokensMatch } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { describeSupport, formatCode } from "./formatter.js";
import { PluginManager } from "./plugin-manager.js";
import { BlackFormatter, type BlackRunner } from "./python.js";

const configSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.string().min(1, "config must be valid JSON"),
]);

/** Build an MCP server bound to a shared plugin manager and immutable config. */
export function buildMcpServer(
  config: ServerConfig,
  plugins: PluginManager,
  black: BlackRunner = new BlackFormatter(config.blackCommand, config.blackTimeoutMs),
): McpServer {
  const server = new McpServer({
    name: "prettier-mcp-formatter",
    version: "1.0.0",
  });

  server.registerTool(
    "format_code",
    {
      title: "Format code with Prettier",
      description:
        "Format source code. Python files (.py/.pyi, or parser=python) use bundled Black; other files use Prettier. Optionally supply a config object (or JSON string) and a list of allowlisted Prettier plugin packages. Plugins do not apply to Python files.",
      inputSchema: {
        filename: z.string().min(1).describe("Virtual filename, used by Prettier to infer the parser."),
        code: z.string().describe("Source code to format."),
        config: configSchema.optional().describe("Prettier options object or JSON string."),
        plugins: z
          .array(z.string())
          .optional()
          .describe("Allowlisted npm plugin packages for Prettier, optionally version-pinned. Ignored for Python."),
      },
      outputSchema: {
        formatted: z.string(),
        plugins: z.array(z.string()),
        filename: z.string(),
      },
    },
    async ({ filename, code, config: prettierConfig, plugins: requestedPlugins }) => {
      try {
        const result = await formatCode(
          {
            filename,
            code,
            ...(prettierConfig === undefined ? {} : { config: prettierConfig }),
            ...(requestedPlugins === undefined ? {} : { plugins: requestedPlugins }),
          },
          plugins,
          black,
        );
        return {
          content: [{ type: "text" as const, text: result.formatted }],
          structuredContent: {
            formatted: result.formatted,
            plugins: result.plugins,
            filename,
          },
        };
      } catch (cause) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: cause instanceof Error ? cause.message : String(cause),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "supported_extensions",
    {
      title: "List supported file extensions",
      description:
        "Report the file extensions this server can format. Includes Python (.py/.pyi) when Black is available. Pass allowlisted plugin package names to include extensions those Prettier plugins provide.",
      inputSchema: {
        plugins: z
          .array(z.string())
          .optional()
          .describe("Allowlisted npm plugin packages to include in the support report."),
      },
      outputSchema: {
        prettierVersion: z.string(),
        extensions: z.array(z.string()),
        languages: z.array(
          z.object({
            name: z.string(),
            extensions: z.array(z.string()),
            filenames: z.array(z.string()),
            parsers: z.array(z.string()),
          }),
        ),
        plugins: z.array(z.string()),
        formatters: z.array(
          z.object({
            name: z.string(),
            version: z.string(),
            extensions: z.array(z.string()),
          }),
        ),
      },
    },
    async ({ plugins: requestedPlugins }) => {
      try {
        const result = await describeSupport(plugins, requestedPlugins ?? [], black);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (cause) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: cause instanceof Error ? cause.message : String(cause),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "cache_info",
    {
      title: "Inspect plugin cache",
      description: "List cached Prettier plugins and the cache directory in use.",
      inputSchema: {},
      outputSchema: {
        cacheDir: z.string(),
        plugins: z.array(
          z.object({
            key: z.string(),
            spec: z.string(),
            version: z.string(),
            installedAt: z.string(),
          }),
        ),
      },
    },
    async () => {
      const info = await plugins.cacheInfo();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
        structuredContent: info as unknown as Record<string, unknown>,
      };
    },
  );

  // Cleanup is admin-only: without a token, the CLI is the sole mechanism.
  const adminToken = config.adminToken;
  if (adminToken !== undefined) {
    server.registerTool(
      "clean_plugin_cache",
      {
        title: "Clear plugin cache",
        description:
          "Remove all cached Prettier plugins. Requires the administrator token and an explicit confirmation.",
        inputSchema: {
          token: z.string().describe("PRETTIER_ADMIN_TOKEN value."),
          confirm: z.literal(true).describe("Must be true."),
        },
        outputSchema: { removed: z.array(z.string()) },
      },
      async ({ token, confirm }) => {
        if (confirm !== true || !tokensMatch(token, adminToken)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Invalid token or confirmation." }],
          };
        }
        const result = await plugins.cleanCache();
        return {
          content: [{ type: "text" as const, text: `Removed ${result.removed.join(", ")}` }],
          structuredContent: result,
        };
      },
    );
  }

  return server;
}
