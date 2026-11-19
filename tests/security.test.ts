import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, sanitizeProcessEnv } from "../src/config.js";
import { formatCode } from "../src/formatter.js";
import { PluginManager } from "../src/plugin-manager.js";
import {
  authorizeSpec,
  parseAllowlist,
  parsePackageSpec,
  PluginNotAllowedError,
  PluginSpecError,
} from "../src/spec.js";
import { makeConfig } from "./helpers/config.js";

const rejectedSpecs = [
  "./local-plugin",
  "../local-plugin",
  "/tmp/plugin",
  "file:../plugin",
  "file:///tmp/plugin.tgz",
  "git+https://github.com/foo/plugin.git",
  "github:foo/plugin",
  "https://registry.example.com/plugin",
  "plugin@https://example.com/registry",
  "plugin.tgz",
  "plugin@latest",
  "@scope/plugin@next",
];

test("rejects non-registry and non-pinned plugin specifications", () => {
  for (const spec of rejectedSpecs) {
    assert.throws(() => parsePackageSpec(spec), PluginSpecError, spec);
  }
});

test("accepts registry package names with semver ranges", () => {
  assert.deepEqual(parsePackageSpec("plugin"), { name: "plugin" });
  assert.deepEqual(parsePackageSpec("@scope/plugin@^1.2.0"), {
    name: "@scope/plugin",
    range: "^1.2.0",
  });
});

test("allowlist entries restrict exact versions and ranges", () => {
  const allowlist = parseAllowlist("plugin-a@^1.0.0,plugin-b");
  assert.throws(
    () => authorizeSpec(parsePackageSpec("plugin-a@2.0.0"), allowlist),
    PluginNotAllowedError,
  );
  assert.deepEqual(authorizeSpec(parsePackageSpec("plugin-a@1.4.0"), allowlist), {
    name: "plugin-a",
    range: "1.4.0",
  });
  assert.deepEqual(authorizeSpec(parsePackageSpec("plugin-a"), allowlist), {
    name: "plugin-a",
    range: "^1.0.0",
  });
  assert.throws(() => authorizeSpec(parsePackageSpec("plugin-c"), allowlist), PluginNotAllowedError);
});

test("unpinned allowlist entries accept new versions without a redeploy", () => {
  const allowlist = parseAllowlist("@prettier/plugin-xml,plugin-b");
  assert.deepEqual(authorizeSpec(parsePackageSpec("@prettier/plugin-xml@3.4.2"), allowlist), {
    name: "@prettier/plugin-xml",
    range: "3.4.2",
  });
  assert.deepEqual(authorizeSpec(parsePackageSpec("@prettier/plugin-xml@4.0.0"), allowlist), {
    name: "@prettier/plugin-xml",
    range: "4.0.0",
  });
  assert.throws(() => authorizeSpec(parsePackageSpec("@prettier/plugin-y"), allowlist), PluginNotAllowedError);
});

test("empty allowlist installs nothing", async () => {
  const config = await makeConfig("https://registry.npmjs.org/", { allowlist: [] });
  const manager = new PluginManager({ config });
  await assert.rejects(manager.loadPlugins(["plugin-a"]), /not in PRETTIER_PLUGIN_ALLOWLIST/);
});

test("no plugin is inferred from the filename", async () => {
  const config = await makeConfig("https://registry.npmjs.org/");
  const manager = new PluginManager({ config });
  const result = await formatCode(
    { filename: "Example.vue", code: "const a = 1", config: { parser: "babel" } },
    manager,
  );
  assert.equal(result.formatted.trim(), "const a = 1;");
  assert.deepEqual(result.plugins, []);
  assert.equal(manager.installCount, 0);
});

test("config accepts a JSON string and rejects malformed config", async () => {
  const config = await makeConfig("https://registry.npmjs.org/");
  const manager = new PluginManager({ config });
  const formatted = await formatCode(
    { filename: "a.js", code: "const a = 1", config: '{"singleQuote": true}' },
    manager,
  );
  assert.match(formatted.formatted, /const a = 1;/);
  await assert.rejects(
    formatCode({ filename: "a.js", code: "x", config: "{not json" }, manager),
    /config must be valid JSON/,
  );
});

test("refuses to clean a directory that is not a managed cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "not-a-cache-"));
  await writeFile(join(dir, "important.txt"), "do not delete");
  const config = await makeConfig("https://registry.npmjs.org/", { cacheDir: dir });
  const manager = new PluginManager({ config });

  await assert.rejects(manager.cleanCache(), /not a prettier-mcp-formatter cache directory/);
});

test("credential-shaped environment variables are removed", () => {
  const env = {
    NPM_TOKEN: "secret",
    npm_config__authToken: "secret",
    GITHUB_TOKEN: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    PATH: "/usr/bin",
  };
  const removed = sanitizeProcessEnv(env);
  assert.deepEqual(removed.sort(), [
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "npm_config__authToken",
  ]);
  assert.deepEqual(Object.keys(env), ["PATH"]);
});

test("configuration validates the allowlist and install timeout", () => {
  const base = {
    PRETTIER_PLUGIN_ALLOWLIST: "plugin-a@^1.0.0",
    PRETTIER_PLUGIN_INSTALL_TIMEOUT: "1500",
  };
  const config = loadConfig(base);
  assert.deepEqual(config.allowlist, [{ name: "plugin-a", range: "^1.0.0" }]);
  assert.equal(config.installTimeoutMs, 1500);
  assert.equal(config.blackCommand, "black");
  assert.equal(config.blackTimeoutMs, 30_000);
  assert.throws(() => loadConfig({ ...base, PRETTIER_PLUGIN_INSTALL_TIMEOUT: "0" }), /integer/);
  assert.throws(() => loadConfig({ BLACK_TIMEOUT_MS: "0" }), /integer/);
  assert.throws(
    () => loadConfig({ PRETTIER_PLUGIN_ALLOWLIST: "file:../evil" }),
    /not a registry package name/,
  );
  assert.throws(
    () => loadConfig({ PRETTIER_PLUGIN_REGISTRY: "http://evil.example.com/" }),
    /must use https/,
  );
});

test("HTTP transport requires a strong bearer token unless explicitly disabled", () => {
  assert.throws(() => loadConfig({ MCP_TRANSPORT: "http" }), /MCP_HTTP_TOKEN/);
  assert.throws(
    () => loadConfig({ MCP_TRANSPORT: "http", MCP_HTTP_TOKEN: "short" }),
    /at least 16 characters/,
  );
  assert.throws(
    () =>
      loadConfig({
        MCP_TRANSPORT: "http",
        MCP_HTTP_TOKEN: "a-long-enough-token",
        MCP_HTTP_ALLOW_UNAUTHENTICATED: "true",
      }),
    /not both/,
  );
  const config = loadConfig({
    MCP_TRANSPORT: "http",
    MCP_HTTP_TOKEN: "a-long-enough-token",
  });
  assert.equal(config.transport, "http");
  assert.equal(config.httpToken, "a-long-enough-token");
  assert.equal(config.httpPath, "/mcp");
  assert.equal(config.httpAllowUnauthenticated, false);

  const tunnelConfig = loadConfig({
    MCP_TRANSPORT: "http",
    MCP_HTTP_ALLOW_UNAUTHENTICATED: "true",
  });
  assert.equal(tunnelConfig.httpToken, undefined);
  assert.equal(tunnelConfig.httpAllowUnauthenticated, true);
});
