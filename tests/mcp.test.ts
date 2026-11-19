import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginManager } from "../src/plugin-manager.js";
import { createServer } from "../src/server.js";
import { makeConfig } from "./helpers/config.js";
import { createFakeBlack } from "./helpers/fake-black.js";
import { createFakeRegistry, type FakeRegistry } from "./helpers/fake-registry.js";

let registry: FakeRegistry;

before(async () => {
  registry = await createFakeRegistry();
  await registry.addPackage("test-plugin", "1.0.0", {});
});

after(async () => {
  await registry.close();
  await rm(registry.dir, { recursive: true, force: true });
});

test("MCP format_code tool installs a plugin and returns formatted code", async () => {
  const config = await makeConfig(registry.url);
  const manager = new PluginManager({ config, registry: registry.url });
  const { server } = createServer({ config, plugins: manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({
      name: "format_code",
      arguments: {
        filename: "Example.shout",
        code: "hello from mcp",
        config: { parser: "shout" },
        plugins: ["test-plugin@1.0.0"],
      },
    });

    assert.equal(result.isError, undefined);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.match(text, /HELLO FROM MCP/);
    assert.deepEqual(result.structuredContent, {
      formatted: text,
      plugins: ["test-plugin@1.0.0"],
      filename: "Example.shout",
    });

    const denied = await client.callTool({
      name: "format_code",
      arguments: {
        filename: "Example.shout",
        code: "hello",
        plugins: ["../../etc/passwd"],
      },
    });
    assert.equal(denied.isError, true);
    assert.match(
      (denied.content as Array<{ text?: string }>)[0]?.text ?? "",
      /not a registry package name|not in PRETTIER_PLUGIN_ALLOWLIST/,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP supported_extensions reports core and plugin-provided extensions", async () => {
  const config = await makeConfig(registry.url);
  const manager = new PluginManager({ config, registry: registry.url });
  const { server } = createServer({ config, plugins: manager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  interface SupportResponse {
    prettierVersion: string;
    extensions: string[];
    languages: Array<{
      name: string;
      extensions: string[];
      filenames: string[];
      parsers: string[];
    }>;
    plugins: string[];
    formatters: Array<{ name: string; version: string; extensions: string[] }>;
  }

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const core = await client.callTool({ name: "supported_extensions" });
    assert.equal(core.isError, undefined);
    const coreResult = core.structuredContent as unknown as SupportResponse;
    assert.match(coreResult.prettierVersion, /^\d+\.\d+\.\d+/);
    assert.ok(coreResult.extensions.includes(".js"));
    assert.ok(coreResult.extensions.includes(".json"));
    assert.ok(!coreResult.extensions.includes(".shout"));
    assert.deepEqual(coreResult.plugins, []);
    assert.ok(coreResult.languages.some((language) => language.name === "JavaScript"));

    const withPlugin = await client.callTool({
      name: "supported_extensions",
      arguments: { plugins: ["test-plugin@1.0.0"] },
    });
    assert.equal(withPlugin.isError, undefined);
    const pluginResult = withPlugin.structuredContent as unknown as SupportResponse;
    assert.ok(pluginResult.extensions.includes(".shout"));
    assert.deepEqual(pluginResult.plugins, ["test-plugin@1.0.0"]);
    assert.ok(
      pluginResult.languages.some(
        (language) => language.name === "Shout" && language.extensions.includes(".shout"),
      ),
    );

    const denied = await client.callTool({
      name: "supported_extensions",
      arguments: { plugins: ["not-allowlisted"] },
    });
    assert.equal(denied.isError, true);
    assert.match(
      (denied.content as Array<{ text?: string }>)[0]?.text ?? "",
      /not in PRETTIER_PLUGIN_ALLOWLIST/,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP tools format Python with Black and report its extensions", async () => {
  const fake = await createFakeBlack();
  try {
    const config = await makeConfig(registry.url, { blackCommand: fake.command });
    const manager = new PluginManager({ config, registry: registry.url });
    const { server } = createServer({ config, plugins: manager });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const formatted = await client.callTool({
        name: "format_code",
        arguments: { filename: "sample.py", code: "x = 1\n" },
      });
      assert.equal(formatted.isError, undefined);
      assert.equal((formatted.content as Array<{ text?: string }>)[0]?.text, "x = 1\n");
      assert.deepEqual(formatted.structuredContent, {
        formatted: "x = 1\n",
        plugins: [],
        filename: "sample.py",
      });

      const support = await client.callTool({ name: "supported_extensions" });
      assert.equal(support.isError, undefined);
      const result = support.structuredContent as unknown as SupportResponse;
      assert.ok(result.extensions.includes(".py"));
      assert.ok(result.formatters.some((formatter) => formatter.name === "black"));
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await fake.close();
  }
});
