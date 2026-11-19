import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isAuthorized } from "./auth.js";
import type { ServerConfig } from "./config.js";

export type McpServerFactory = () => McpServer;

function chunkBytes(chunk: unknown, encoding: BufferEncoding = "utf8"): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk, encoding);
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

function requestBytes(req: IncomingMessage): number {
  const raw = req.headers["content-length"];
  if (typeof raw !== "string") return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Count bytes written to the response without changing what gets sent. */
function trackResponseBytes(res: ServerResponse): () => number {
  let bytes = 0;
  const write = res.write.bind(res);
  const end = res.end.bind(res);

  res.write = ((chunk: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    bytes += chunkBytes(chunk, typeof encoding === "function" ? undefined : encoding);
    const cb = typeof encoding === "function" ? encoding : callback;
    return write(chunk as string | Uint8Array, encoding as BufferEncoding, cb);
  }) as typeof res.write;

  res.end = ((
    chunk?: unknown,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    if (chunk !== undefined && chunk !== null) {
      bytes += chunkBytes(chunk, typeof encoding === "function" ? undefined : encoding);
    }
    const cb = typeof encoding === "function" ? encoding : callback;
    return end(chunk as string | Uint8Array | undefined, encoding as BufferEncoding, cb);
  }) as typeof res.end;

  return () => bytes;
}

/**
 * Expose the MCP server over Streamable HTTP. The SDK's stateless mode requires
 * a fresh transport for every request, so each request gets its own MCP server
 * and transport while sharing the configured plugin manager.
 */
export async function startHttpServer(
  config: ServerConfig,
  createMcpServer: McpServerFactory,
): Promise<Server> {
  const token = config.httpToken;
  if (token === undefined && !config.httpAllowUnauthenticated) {
    throw new Error(
      "Refusing to start HTTP transport without MCP_HTTP_TOKEN or MCP_HTTP_ALLOW_UNAUTHENTICATED=true.",
    );
  }
  if (token === undefined) {
    console.error(
      "WARNING: MCP HTTP authentication is disabled. This endpoint must only be reachable through a private tunnel.",
    );
  }

  const httpServer = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const receivedAt = new Date();
    const startedAt = process.hrtime.bigint();
    const bytesIn = requestBytes(req);
    const responseBytes = trackResponseBytes(res);
    let logged = false;
    const logRequest = (): void => {
      if (logged) return;
      logged = true;
      const durationMs = (Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1);
      const client = req.socket.remoteAddress ?? "-";
      console.log(
        `${receivedAt.toISOString()} ${req.method ?? "-"} ${path} ${res.statusCode} ${durationMs}ms bytes_in=${bytesIn} bytes_out=${responseBytes()} ${client}`,
      );
    };
    res.once("finish", logRequest);
    res.once("close", logRequest);

    if (path === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }

    if (path !== config.httpPath) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
      return;
    }

    if (token !== undefined && !isAuthorized(req.headers, token)) {
      res.writeHead(401, {
        "content-type": "text/plain",
        "www-authenticate": 'Bearer realm="prettier-mcp-formatter"',
      }).end("Unauthorized\n");
      return;
    }

    let mcp: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      mcp = createMcpServer();
      transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (cause) {
      console.error("MCP HTTP request failed:", cause);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      res.end(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // handleRequest has finished writing the response (or it failed), so the
      // per-request transport can be released. Errors here are cleanup noise.
      await transport?.close().catch(() => {});
      await mcp?.close().catch(() => {});
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.httpPort, config.httpHost, resolve);
  });
  return httpServer;
}
