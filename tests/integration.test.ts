import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { formatCode } from "../src/formatter.js";
import { PluginManager } from "../src/plugin-manager.js";
import { parseAllowlist } from "../src/spec.js";
import { makeConfig } from "./helpers/config.js";
import { createFakeRegistry, type FakeRegistry } from "./helpers/fake-registry.js";

let registry: FakeRegistry;

before(async () => {
  registry = await createFakeRegistry();
  await registry.addPackage("test-plugin", "1.0.0", {});
  await registry.addPackage("test-plugin", "1.1.0", {});
  await registry.addPackage("test-plugin", "2.0.0", {});
  await registry.addPackage("lifecycle-plugin", "1.0.0", {}, { lifecycle: true });
});

after(async () => {
  await registry.close();
  await rm(registry.dir, { recursive: true, force: true });
});

async function managerFor(overrides: Parameters<typeof makeConfig>[1] = {}) {
  const config = await makeConfig(registry.url, overrides);
  const manager = new PluginManager({ config, registry: registry.url });
  return { manager, config };
}

test("installs an allowlisted plugin automatically and formats with it", async () => {
  const { manager } = await managerFor();
  const result = await formatCode(
    {
      filename: "Example.shout",
      code: "hello world",
      config: { plugins: ["test-plugin"] },
    },
    manager,
  );

  assert.match(result.formatted, /HELLO WORLD/);
  assert.match(result.formatted, /\/\/ plugin 2\.0\.0/);
  assert.deepEqual(result.plugins, ["test-plugin"]);
  assert.equal(manager.installCount, 1);
});

test("reuses a cached plugin without another download", async () => {
  const { manager } = await managerFor();
  await formatCode(
    { filename: "a.shout", code: "one", config: { parser: "shout", plugins: ["test-plugin"] } },
    manager,
  );
  const requestsAfterFirst = registry.requests.length;

  await formatCode(
    { filename: "b.shout", code: "two", config: { parser: "shout", plugins: ["test-plugin"] } },
    manager,
  );

  assert.equal(manager.installCount, 1);
  assert.equal(registry.requests.length, requestsAfterFirst);
});

test("rejects a plugin that is not allowlisted", async () => {
  const { manager } = await managerFor({
    allowlist: parseAllowlist("some-other-plugin"),
  });

  await assert.rejects(
    formatCode(
      { filename: "a.shout", code: "x", config: { plugins: ["test-plugin"] } },
      manager,
    ),
    /not in PRETTIER_PLUGIN_ALLOWLIST/,
  );
  assert.equal(manager.installCount, 0);
});

test("resolves version-pinned plugins and enforces allowlist version constraints", async () => {
  const { manager } = await managerFor({
    allowlist: parseAllowlist("test-plugin@^1.0.0"),
  });

  const pinned = await formatCode(
    {
      filename: "a.shout",
      code: "x",
      config: { parser: "shout", plugins: ["test-plugin@1.0.0"] },
    },
    manager,
  );
  assert.match(pinned.formatted, /\/\/ plugin 1\.0\.0/);
  assert.equal(pinned.plugins[0], "test-plugin@1.0.0");

  // An unpinned request is resolved within the administrator's range.
  const unpinned = await formatCode(
    { filename: "b.shout", code: "y", config: { parser: "shout", plugins: ["test-plugin"] } },
    manager,
  );
  assert.match(unpinned.formatted, /\/\/ plugin 1\.1\.0/);

  await assert.rejects(
    formatCode(
      {
        filename: "c.shout",
        code: "z",
        config: { parser: "shout", plugins: ["test-plugin@2.0.0"] },
      },
      manager,
    ),
    /outside the allowed range/,
  );
});

test("reports unavailable packages clearly", async () => {
  const { manager } = await managerFor({
    allowlist: parseAllowlist("missing-plugin"),
  });

  await assert.rejects(
    formatCode(
      { filename: "a.shout", code: "x", config: { plugins: ["missing-plugin"] } },
      manager,
    ),
    /Failed to install plugin "missing-plugin"/,
  );
});

test("applies installation timeouts", async () => {
  const { manager } = await managerFor({ installTimeoutMs: 200 });
  registry.delayNextRequest(3_000, 10);

  try {
    await assert.rejects(
      formatCode(
        { filename: "a.shout", code: "x", config: { plugins: ["test-plugin@1.1.0"] } },
        manager,
      ),
      /timed out after 200ms/,
    );
  } finally {
    registry.clearDelay();
  }
});

test("deduplicates concurrent installs of the same plugin", async () => {
  const { manager } = await managerFor();
  const results = await Promise.all(
    [1, 2, 3].map((index) =>
      formatCode(
        {
          filename: `file${index}.shout`,
          code: `code ${index}`,
          config: { parser: "shout", plugins: ["test-plugin@1.0.0"] },
        },
        manager,
      ),
    ),
  );

  assert.equal(manager.installCount, 1);
  for (const result of results) assert.match(result.formatted, /CODE [123]/);
});

test("npm lifecycle scripts are disabled", async () => {
  const { manager, config } = await managerFor();
  await formatCode(
    { filename: "a.shout", code: "x", config: { plugins: ["lifecycle-plugin"] } },
    manager,
  );

  const files = await readdir(config.cacheDir, { recursive: true });
  assert.equal(files.some((file) => file.endsWith("RAN_POSTINSTALL")), false);
});

test("cache survives a manager restart", async () => {
  const config = await makeConfig(registry.url);
  const first = new PluginManager({ config, registry: registry.url });
  await first.loadPlugins(["test-plugin@1.0.0"]);
  assert.equal(first.installCount, 1);

  const beforeRestart = registry.requests.length;
  const second = new PluginManager({ config, registry: registry.url });
  await second.loadPlugins(["test-plugin@1.0.0"]);

  assert.equal(second.installCount, 0);
  assert.equal(registry.requests.length, beforeRestart);
});

test("supports multiple versions in the cache", async () => {
  const { manager, config } = await managerFor();
  await manager.loadPlugins(["test-plugin@1.0.0"]);
  await manager.loadPlugins(["test-plugin@1.1.0"]);

  assert.equal(manager.installCount, 2);
  const info = await manager.cacheInfo();
  assert.deepEqual(
    info.plugins.map((entry) => entry.version).sort(),
    ["1.0.0", "1.1.0"],
  );
  assert.ok((await readdir(config.cacheDir)).some((entry) => entry.startsWith("test-plugin-")));
});

test("fails clearly when auto-install is disabled and the plugin is not cached", async () => {
  const { manager } = await managerFor({ autoInstall: false });

  await assert.rejects(
    manager.loadPlugins(["test-plugin"]),
    /automatic installation is disabled/,
  );
});

test("cache cleanup removes only managed plugin data", async () => {
  const { manager, config } = await managerFor();
  await manager.loadPlugins(["test-plugin@1.0.0"]);
  const result = await manager.cleanCache();

  assert.deepEqual(result.removed, [config.cacheDir]);
  assert.deepEqual((await manager.cacheInfo()).plugins, []);
});
