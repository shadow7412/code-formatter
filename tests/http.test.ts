import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PluginManager } from "../src/plugin-manager.js";
import { createServer } from "../src/server.js";
import { startHttpServer } from "../src/http.js";
import { makeConfig } from "./helpers/config.js";

const TOKEN = "integration-test-token-0123456789";

test("HTTP transport authenticates requests and serves MCP tools", async () => {
  const config = await makeConfig("https://registry.npmjs.org/", {
    transport: "http",
    httpPort: 0,
    httpToken: TOKEN,
  });
  const manager = new PluginManager({ config });
  const { server, createMcpServer } = createServer({ config, plugins: manager });
  await server.close();
  const httpServer = await startHttpServer(config, createMcpServer);

  try {
    const address = httpServer.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok\n");

    const wrongPath = await fetch(`${base}/nope`);
    assert.equal(wrongPath.status, 404);

    const unauthenticated = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "probe", version: "1.0.0" },
        },
      }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("www-authenticate"), 'Bearer realm="prettier-mcp-formatter"');

    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    try {
      const result = await client.callTool({
        name: "format_code",
        arguments: { filename: "Example.js", code: "const a=1" },
      });
      assert.equal(result.isError, undefined);
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
      assert.equal(text, "const a = 1;\n");
    } finally {
      await client.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    await server.close();
  }
});

test("HTTP transport logs one line per request", async () => {
  const config = await makeConfig("https://registry.npmjs.org/", {
    transport: "http",
    httpPort: 0,
    httpToken: TOKEN,
  });
  const manager = new PluginManager({ config });
  const { server, createMcpServer } = createServer({ config, plugins: manager });
  await server.close();
  const httpServer = await startHttpServer(config, createMcpServer);

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const address = httpServer.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const unauthorized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body,
    });
    assert.equal(unauthorized.status, 401);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? "", timestamp);
    assert.match(lines[0] ?? "", /GET \/healthz 200 \d+\.\dms bytes_in=0 bytes_out=3 /);
    assert.match(lines[1] ?? "", timestamp);
    assert.match(lines[1] ?? "", /GET \/nope 404 \d+\.\dms bytes_in=0 bytes_out=10 /);
    assert.match(lines[2] ?? "", timestamp);
    assert.match(
      lines[2] ?? "",
      new RegExp(`POST /mcp 401 \\d+\\.\\dms bytes_in=${Buffer.byteLength(body)} bytes_out=13 `),
    );
    assert.ok(lines.every((line) => !line.includes("\n")));
  } finally {
    console.log = originalLog;
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    await server.close();
  }
});

test("HTTP transport can run without auth for a private tunnel", async () => {
  const config = await makeConfig("https://registry.npmjs.org/", {
    transport: "http",
    httpPort: 0,
    httpAllowUnauthenticated: true,
  });
  const manager = new PluginManager({ config });
  const { server, createMcpServer } = createServer({ config, plugins: manager });
  await server.close();
  const httpServer = await startHttpServer(config, createMcpServer);

  try {
    const address = httpServer.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "no-auth-probe", version: "1.0.0" },
        },
      }),
    });
    assert.equal(response.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    await server.close();
  }
});
