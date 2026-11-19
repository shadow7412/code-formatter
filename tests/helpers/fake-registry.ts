import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface VersionFiles {
  [path: string]: string;
}

interface RegistryPackage {
  name: string;
  versions: Map<string, string>;
}

export interface FakeRegistry {
  url: string;
  dir: string;
  requests: string[];
  addPackage(name: string, version: string, files: VersionFiles, options?: { lifecycle?: boolean }): Promise<void>;
  delayNextRequest(ms: number, count?: number): void;
  clearDelay(): void;
  close(): Promise<void>;
}

function tarballName(name: string, version: string): string {
  return `${name.replace("/", "-")}-${version}.tgz`;
}

function pluginSource(version: string): string {
  return `'use strict';\nconst version = ${JSON.stringify(version)};\nmodule.exports = {\n  parsers: {\n    shout: {\n      parse(text) { return { type: 'root', value: text.trim() }; },\n      astFormat: 'shout-ast',\n      locStart() { return 0; },\n      locEnd() { return 0; },\n    },\n  },\n  printers: {\n    'shout-ast': {\n      print(path) { return path.getValue().value.toUpperCase() + '\\n// plugin ' + version + '\\n'; },\n    },\n  },\n  languages: [{ name: 'Shout', parsers: ['shout'], extensions: ['.shout'] }],\n};\n`;
}

async function pack(dir: string, destination: string): Promise<string> {
  const name = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--pack-destination", destination, "--ignore-scripts", "--silent"],
      { cwd: dir, env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" } },
    );
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.stderr?.on("data", (chunk) => (err += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(out.trim().split("\n").pop() ?? "");
      else reject(new Error(`npm pack failed (${code}): ${err}`));
    });
  });
  if (name === "") throw new Error("npm pack produced no tarball");
  return name;
}

export async function createFakeRegistry(): Promise<FakeRegistry> {
  const dir = await mkdtemp(join(tmpdir(), "prettier-plugin-registry-"));
  const packages = new Map<string, RegistryPackage>();
  const requests: string[] = [];
  let delay = 0;
  let delayCount = 0;

  const server: Server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    requests.push(path);
    if (delay > 0 && delayCount > 0) {
      const ms = delay;
      delayCount -= 1;
      await new Promise((done) => setTimeout(done, ms));
    }

    try {
      const decoded = decodeURIComponent(path.split("?")[0] ?? "");
      if (decoded.endsWith(".tgz")) {
        for (const pkg of packages.values()) {
          for (const [version, tarball] of pkg.versions) {
            if (tarballName(pkg.name, version) === decoded.slice(1)) {
              res.writeHead(200, { "content-type": "application/octet-stream" });
              res.end(await readFile(tarball));
              return;
            }
          }
        }
        res.writeHead(404).end("not found");
        return;
      }

      const pkg = packages.get(decoded.slice(1));
      if (pkg === undefined) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
        return;
      }
      const versions = [...pkg.versions.keys()].sort();
      const latest = versions.at(-1) ?? "0.0.0";
      const body: Record<string, unknown> = {
        name: pkg.name,
        "dist-tags": { latest },
        versions: {} as Record<string, unknown>,
      };
      const versionMap = body.versions as Record<string, unknown>;
      for (const [version, tarball] of pkg.versions) {
        const bytes = await readFile(tarball);
        versionMap[version] = {
          name: pkg.name,
          version,
          dist: {
            tarball: `${baseUrl}/${tarballName(pkg.name, version)}`,
            shasum: createHash("sha1").update(bytes).digest("hex"),
            integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          },
        };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    } catch (cause) {
      res.writeHead(500).end(String(cause));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    url: `${baseUrl}/`,
    dir,
    requests,
    delayNextRequest(ms: number, count = 1) {
      delay = ms;
      delayCount = count;
    },
    clearDelay() {
      delay = 0;
      delayCount = 0;
    },
    async addPackage(name, version, files, options) {
      const pkgDir = join(dir, `src-${name.replace(/[^a-z0-9]/gi, "-")}-${version}`);
      await mkdir(pkgDir, { recursive: true });
      const scripts = options?.lifecycle
        ? { scripts: { postinstall: `node -e "require('fs').writeFileSync('RAN_POSTINSTALL','yes')"` } }
        : {};
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify(
          {
            name,
            version,
            main: "index.js",
            ...scripts,
          },
          null,
          2,
        ),
      );
      await writeFile(join(pkgDir, "index.js"), files["index.js"] ?? pluginSource(version));
      for (const [file, content] of Object.entries(files)) {
        if (file === "index.js") continue;
        await writeFile(join(pkgDir, file), content);
      }
      const tarball = await pack(pkgDir, dir);
      let entry = packages.get(name);
      if (entry === undefined) {
        entry = { name, versions: new Map() };
        packages.set(name, entry);
      }
      entry.versions.set(version, join(dir, tarball));
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
