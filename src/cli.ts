import { loadConfig, sanitizeProcessEnv } from "./config.js";
import { PluginManager } from "./plugin-manager.js";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  sanitizeProcessEnv();
  const manager = new PluginManager({ config: loadConfig() });

  if (command === "clean") {
    if (rest.length > 0) {
      throw new Error("Usage: prettier-plugin-cache clean");
    }
    const result = await manager.cleanCache();
    console.log(`Cleared plugin cache: ${result.removed.join(", ")}`);
    return;
  }

  if (command === "list") {
    const info = await manager.cacheInfo();
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  throw new Error("Usage: prettier-plugin-cache <clean|list>");
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});

export {};
