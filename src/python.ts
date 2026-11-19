import { spawn } from "node:child_process";

export const BLACK_EXTENSIONS = [".py", ".pyi"] as const;

export interface BlackOptions {
  lineLength?: number;
  skipStringNormalization?: boolean;
  skipMagicTrailingComma?: boolean;
  preview?: boolean;
  unstable?: boolean;
  targetVersions?: string[];
  pyi?: boolean;
}

export interface BlackRunResult {
  stdout: string;
  stderr: string;
}

export interface BlackRunner {
  version(): Promise<string | undefined>;
  format(filename: string, code: string, config: Record<string, unknown>): Promise<string>;
}

export class BlackError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BlackError";
  }
}

export class BlackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlackConfigError";
  }
}

const ALLOWED_BLACK_OPTIONS = new Set([
  "lineLength",
  "skipStringNormalization",
  "skipMagicTrailingComma",
  "preview",
  "unstable",
  "targetVersion",
  "pyi",
]);

const TARGET_VERSION = /^py\d{2,3}$/i;

function devNullPath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function asPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BlackConfigError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BlackConfigError(`${label} must be a positive integer.`);
  }
  return value;
}

function booleanOption(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new BlackConfigError(`${label} must be a boolean.`);
  }
  return value;
}

/** Validate the small, explicit subset of Black options exposed through config. */
export function parseBlackOptions(
  filename: string,
  config: Record<string, unknown>,
): BlackOptions {
  const options: BlackOptions = {};

  if (config.lineWidth !== undefined) {
    options.lineLength = positiveInteger(config.lineWidth, "lineWidth");
  }

  if (config.black !== undefined) {
    const raw = asPlainObject(config.black, "black");
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_BLACK_OPTIONS.has(key)) {
        throw new BlackConfigError(`Unknown Black option "${key}".`);
      }
    }

    if (raw.lineLength !== undefined) {
      options.lineLength = positiveInteger(raw.lineLength, "black.lineLength");
    }
    if (raw.skipStringNormalization !== undefined) {
      options.skipStringNormalization = booleanOption(
        raw.skipStringNormalization,
        "black.skipStringNormalization",
      );
    }
    if (raw.skipMagicTrailingComma !== undefined) {
      options.skipMagicTrailingComma = booleanOption(
        raw.skipMagicTrailingComma,
        "black.skipMagicTrailingComma",
      );
    }
    if (raw.preview !== undefined) {
      options.preview = booleanOption(raw.preview, "black.preview");
    }
    if (raw.unstable !== undefined) {
      options.unstable = booleanOption(raw.unstable, "black.unstable");
    }
    if (raw.targetVersion !== undefined) {
      const entries = Array.isArray(raw.targetVersion) ? raw.targetVersion : [raw.targetVersion];
      options.targetVersions = entries.map((entry, index) => {
        if (typeof entry !== "string" || !TARGET_VERSION.test(entry)) {
          throw new BlackConfigError(
            `black.targetVersion[${index}] must look like "py311" or "py312".`,
          );
        }
        return entry.toLowerCase();
      });
    }
    if (raw.pyi !== undefined) {
      options.pyi = booleanOption(raw.pyi, "black.pyi");
    }
  }

  if (filename.toLowerCase().endsWith(".pyi")) options.pyi = true;
  return options;
}

/** Python files, or an explicit Python parser, are handled by Black. */
export function isPythonTarget(filename: string, config: Record<string, unknown>): boolean {
  const lower = filename.toLowerCase();
  if (BLACK_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;
  return config.parser === "python" || config.parser === "pyi";
}

function buildArgs(filename: string, options: BlackOptions): string[] {
  const args = ["--quiet", "--no-cache", "--config", devNullPath()];

  if (options.lineLength !== undefined) args.push(`--line-length=${options.lineLength}`);
  if (options.skipStringNormalization === true) args.push("--skip-string-normalization");
  if (options.skipMagicTrailingComma === true) args.push("--skip-magic-trailing-comma");
  if (options.preview === true) args.push("--preview");
  if (options.unstable === true) args.push("--unstable");
  for (const version of options.targetVersions ?? []) args.push(`--target-version=${version}`);
  if (options.pyi === true) args.push("--pyi");

  args.push("--stdin-filename", filename, "-");
  return args;
}

function lastError(output: string): string {
  const trimmed = output.trim();
  if (trimmed === "") return "no error output";
  return trimmed.slice(-4000);
}

/** Runs a fixed Black command with validated arguments. No shell is involved. */
export class BlackFormatter implements BlackRunner {
  private versionPromise?: Promise<string | undefined>;

  constructor(
    private readonly command: string,
    private readonly timeoutMs: number,
  ) {}

  version(): Promise<string | undefined> {
    if (this.versionPromise === undefined) {
      this.versionPromise = this.run(["--version"], "")
        .then(({ stdout, stderr }) => {
          const match = `${stdout}\n${stderr}`.match(/\bblack,?\s+v?([0-9][^\s,]*)/i);
          return match?.[1];
        })
        .catch(() => undefined);
    }
    return this.versionPromise;
  }

  async format(filename: string, code: string, config: Record<string, unknown>): Promise<string> {
    const options = parseBlackOptions(filename, config);
    const { stdout } = await this.run(buildArgs(filename, options), code);
    return stdout;
  }

  private run(args: readonly string[], input: string): Promise<BlackRunResult> {
    return new Promise<BlackRunResult>((resolve, reject) => {
      const child = spawn(this.command, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let settled = false;
      let stdout = "";
      let stderr = "";

      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => {
        finish(() => {
          child.kill("SIGKILL");
          reject(new BlackError(`Black timed out after ${this.timeoutMs}ms.`));
        });
      }, this.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 8000) stderr += chunk;
      });
      child.stdin.on("error", () => {
        // The child may close stdin early; its exit status is the real result.
      });
      child.on("error", (cause) => {
        finish(() =>
          reject(
            new BlackError(`Could not start Black command "${this.command}": ${cause.message}`, {
              cause,
            }),
          ),
        );
      });
      child.on("close", (code, signal) => {
        finish(() => {
          if (code !== 0) {
            reject(
              new BlackError(
                `Black exited with ${signal === null ? `code ${code}` : `signal ${signal}`}: ${lastError(stderr)}`,
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        });
      });

      child.stdin.end(input);
    });
  }
}
