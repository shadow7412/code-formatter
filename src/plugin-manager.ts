import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import semver from "semver";
import type { ServerConfig } from "./config.js";
import {
  authorizeSpec,
  formatPackageSpec,
  parsePackageSpec,
  type PackageSpec,
} from "./spec.js";

const CACHE_MARKER = ".prettier-plugin-cache";
const MANIFEST = "manifest.json";
const MAX_NPM_LOG_CHARS = 32_000;

export class PluginInstallError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PluginInstallError";
  }
}

export class PluginLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PluginLoadError";
  }
}

interface CacheEntry {
  spec: string;
  version: string;
  installedAt: string;
}

interface CacheManifest {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export interface CacheInfo {
  cacheDir: string;
  plugins: Array<CacheEntry & { key: string }>;
}

export interface PluginManagerOptions {
  config: ServerConfig;
  /** Test/enterprise override. Never sourced from a formatting request. */
  registry?: string;
  /** Injected for hermetic tests. */
  npmBinary?: string;
}

/** Downloads, caches, authorizes and loads Prettier plugins. */
export class PluginManager {
  readonly config: ServerConfig;
  private readonly registry: string;
  private readonly npmCommand: string[];
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly loaded = new Map<string, unknown>();
  private manifestWrite: Promise<void> = Promise.resolve();
  /** Number of actual npm installs performed; handy for cache assertions. */
  installCount = 0;

  constructor(options: PluginManagerOptions) {
    this.config = options.config;
    this.registry = options.registry ?? options.config.registry;
    // Prefer the exact npm CLI npm itself reports. This also sidesteps shell
    // wrappers that need a full login environment (and can eat our limits).
    const npmCli = process.env.npm_execpath;
    this.npmCommand =
      npmCli !== undefined && npmCli.endsWith(".js") && existsSync(npmCli)
        ? [process.execPath, npmCli]
        : [options.npmBinary ?? "npm"];
  }

  private cacheKey(spec: PackageSpec): string {
    return createHash("sha256")
      .update(formatPackageSpec(spec))
      .digest("hex")
      .slice(0, 16);
  }

  private dirForKey(key: string, spec: PackageSpec): string {
    const slug = spec.name.replace(/^@/, "").replace("/", "__");
    return join(this.config.cacheDir, `${slug}-${key}`);
  }

  private async ensureCache(): Promise<void> {
    await mkdir(this.config.cacheDir, { recursive: true });
    const marker = join(this.config.cacheDir, CACHE_MARKER);
    if (!existsSync(marker)) {
      await writeFile(
        marker,
        "This directory is managed by prettier-mcp-formatter. Do not store other files here.\n",
        "utf8",
      );
    }
    await mkdir(join(this.config.cacheDir, ".npm-home"), { recursive: true });
    await writeFile(join(this.config.cacheDir, ".npmrc.user"), "", "utf8");
    await writeFile(join(this.config.cacheDir, ".npmrc.global"), "", "utf8");
  }

  private async readManifest(): Promise<CacheManifest> {
    try {
      const raw = await readFile(join(this.config.cacheDir, MANIFEST), "utf8");
      const parsed = JSON.parse(raw) as CacheManifest;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        return parsed;
      }
    } catch {
      // A missing or corrupt manifest is not fatal; installed packages are
      // still discovered from the filesystem.
    }
    return { version: 1, entries: {} };
  }

  private async recordInstall(key: string, spec: PackageSpec, version: string): Promise<void> {
    const run = this.manifestWrite.then(async () => {
      const manifest = await this.readManifest();
      manifest.entries[key] = {
        spec: formatPackageSpec(spec),
        version,
        installedAt: new Date().toISOString(),
      };
      const target = join(this.config.cacheDir, MANIFEST);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(manifest, null, 2), "utf8");
      await rename(temporary, target);
    });
    this.manifestWrite = run.catch(() => undefined);
    await run;
  }

  private packageJsonPath(dir: string, name: string): string {
    return join(dir, "node_modules", ...name.split("/"), "package.json");
  }

  private async installedVersion(dir: string, spec: PackageSpec): Promise<string | undefined> {
    try {
      const raw = await readFile(this.packageJsonPath(dir, spec.name), "utf8");
      const pkg = JSON.parse(raw) as { version?: unknown };
      if (typeof pkg.version !== "string") return undefined;
      if (spec.range !== undefined && !semver.satisfies(pkg.version, spec.range, { includePrerelease: true })) {
        return undefined;
      }
      return pkg.version;
    } catch {
      return undefined;
    }
  }

  /**
   * Authorize, install if needed, and load plugins. Duplicate specs within a
   * request and concurrent installs of the same spec are handled once.
   */
  async loadPlugins(requestedSpecs: readonly string[]): Promise<{
    plugins: unknown[];
    specs: string[];
  }> {
    const specs = new Map<string, PackageSpec>();
    for (const raw of requestedSpecs) {
      const spec = authorizeSpec(parsePackageSpec(raw), this.config.allowlist);
      specs.set(formatPackageSpec(spec), spec);
    }

    const plugins: unknown[] = [];
    for (const spec of specs.values()) {
      plugins.push(await this.loadPlugin(spec));
    }
    return { plugins, specs: [...specs.keys()] };
  }

  private async loadPlugin(spec: PackageSpec): Promise<unknown> {
    const key = this.cacheKey(spec);
    const dir = this.dirForKey(key, spec);
    await this.ensureInstalled(spec, key, dir);

    const cached = this.loaded.get(key);
    if (cached !== undefined) return cached;

    const parent = pathToFileURL(join(dir, "package.json")).href;
    let entry: string;
    try {
      // ESM-first: supports packages whose "exports" only expose "import".
      entry = import.meta.resolve(spec.name, parent);
    } catch {
      try {
        entry = createRequire(join(dir, "__plugin_loader__.cjs")).resolve(spec.name);
      } catch (cause) {
        throw new PluginLoadError(
          `Could not resolve installed plugin "${formatPackageSpec(spec)}" from cache.`,
          { cause },
        );
      }
    }

    try {
      const url = entry.startsWith("file:") ? entry : pathToFileURL(entry).href;
      const module = (await import(url)) as Record<string, unknown>;
      const hasPluginExports =
        "parsers" in module || "printers" in module || "languages" in module || "options" in module;
      const plugin = module.default !== undefined && !hasPluginExports ? module.default : module;
      if (plugin === null || typeof plugin !== "object") {
        throw new Error("Plugin module does not export a Prettier plugin object.");
      }
      this.loaded.set(key, plugin);
      return plugin;
    } catch (cause) {
      if (cause instanceof PluginLoadError) throw cause;
      throw new PluginLoadError(
        `Failed to load plugin "${formatPackageSpec(spec)}": ${errorMessage(cause)}`,
        { cause },
      );
    }
  }

  private async ensureInstalled(spec: PackageSpec, key: string, dir: string): Promise<string> {
    const version = await this.installedVersion(dir, spec);
    if (version !== undefined) return dir;

    if (!this.config.autoInstall) {
      throw new PluginInstallError(
        `Plugin "${formatPackageSpec(spec)}" is not cached and automatic installation is disabled (PRETTIER_PLUGIN_AUTO_INSTALL).`,
      );
    }

    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;

    const task = this.install(spec, key, dir).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }

  private async install(spec: PackageSpec, key: string, dir: string): Promise<string> {
    await this.ensureCache();
    await mkdir(dir, { recursive: true });

    // An isolated host package stops npm from walking into (or writing to)
    // the application's own package.json / node_modules.
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "prettier-plugin-host", version: "1.0.0", private: true }, null, 2)}\n`,
      "utf8",
    );

    const npmHome = join(this.config.cacheDir, ".npm-home");
    const npmCache = join(this.config.cacheDir, ".npm-cache");
    const userConfig = join(this.config.cacheDir, ".npmrc.user");
    const globalConfig = join(this.config.cacheDir, ".npmrc.global");
    await mkdir(npmHome, { recursive: true });
    await mkdir(npmCache, { recursive: true });

    // Built from scratch: no NPM_TOKEN, .npmrc, proxy or other credentials
    // from the server process can reach the installer.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: npmHome,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      NODE_NO_WARNINGS: "1",
      npm_config_registry: this.registry,
      npm_config_cache: npmCache,
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
    };

    const args = [
      "install",
      "--prefix",
      dir,
      "--ignore-scripts",
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--no-bin-links",
      "--omit=dev",
      "--prefer-offline",
      "--loglevel=error",
      formatPackageSpec(spec),
    ];

    // Resource limits are applied to npm itself, before any plugin code runs.
    // On non-Linux systems ulimit is best-effort; the timeout still applies.
    const script =
      'ulimit -v "$1" 2>/dev/null || true; ulimit -t "$2" 2>/dev/null || true; shift 2; exec "$@"';
    const memoryKb = String(this.config.maxMemoryMb * 1024);
    const cpuSeconds = String(this.config.maxCpuSeconds);
    const child = spawn(
      "/bin/sh",
      ["-c", script, "sh", memoryKb, cpuSeconds, ...this.npmCommand, ...args],
      { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-MAX_NPM_LOG_CHARS);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_NPM_LOG_CHARS);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, this.config.installTimeoutMs);
    timer.unref?.();

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveResult, rejectResult) => {
        child.once("error", rejectResult);
        child.once("close", (code, signal) => resolveResult({ code, signal }));
      },
    ).finally(() => clearTimeout(timer));

    this.installCount += 1;

    if (timedOut || result.signal !== null) {
      await rm(dir, { recursive: true, force: true });
      throw new PluginInstallError(
        `Installation of plugin "${formatPackageSpec(spec)}" ${timedOut ? `timed out after ${this.config.installTimeoutMs}ms` : `was killed (${result.signal})`}.`,
      );
    }
    if (result.code !== 0) {
      const detail = (stderr.trim() || stdout.trim()).slice(-2_000);
      await rm(dir, { recursive: true, force: true });
      throw new PluginInstallError(
        `Failed to install plugin "${formatPackageSpec(spec)}" (npm exited with ${result.code}).${detail ? ` ${detail}` : ""}`,
      );
    }

    const version = await this.installedVersion(dir, spec);
    if (version === undefined) {
      await rm(dir, { recursive: true, force: true });
      throw new PluginInstallError(
        `Plugin "${formatPackageSpec(spec)}" installed but its package metadata could not be verified.`,
      );
    }

    await this.linkPrettier(dir);
    await this.recordInstall(key, spec, version);
    return dir;
  }

  private async linkPrettier(dir: string): Promise<void> {
    const nodeModules = join(dir, "node_modules");
    const target = join(nodeModules, "prettier");
    if (existsSync(target)) return;
    try {
      const prettierPackage = createRequire(import.meta.url).resolve("prettier/package.json");
      await mkdir(nodeModules, { recursive: true });
      await symlink(dirname(prettierPackage), target, "dir");
    } catch {
      // Not all plugins import prettier directly; a failed link is harmless.
    }
  }

  /** Administrator-controlled cache cleanup (also exposed via the CLI). */
  async cleanCache(): Promise<{ removed: string[] }> {
    const target = resolve(this.config.cacheDir);
    const dangerous = [resolve("/"), resolve(tmpdir()), process.cwd()];
    if (dangerous.includes(target)) {
      throw new Error(`Refusing to clean unsafe cache directory "${target}".`);
    }
    if (!existsSync(target)) return { removed: [] };
    if (!existsSync(join(target, CACHE_MARKER)) && (await readdirHasEntries(target))) {
      throw new Error(
        `Refusing to clean "${target}": it is not a prettier-mcp-formatter cache directory.`,
      );
    }
    await rm(target, { recursive: true, force: true });
    this.loaded.clear();
    this.inflight.clear();
    await this.ensureCache();
    return { removed: [target] };
  }

  async cacheInfo(): Promise<CacheInfo> {
    await this.ensureCache();
    const manifest = await this.readManifest();
    const plugins = Object.entries(manifest.entries)
      .filter(([key, entry]) => {
        try {
          return existsSync(this.dirForKey(key, parsePackageSpec(entry.spec)));
        } catch {
          return false;
        }
      })
      .map(([key, entry]) => ({ key, ...entry }));
    return { cacheDir: this.config.cacheDir, plugins };
  }
}

async function readdirHasEntries(dir: string): Promise<boolean> {
  return (await readdir(dir)).length > 0;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
