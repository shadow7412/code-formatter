import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeBlack {
  command: string;
  argsLog: string;
  dir: string;
  close(): Promise<void>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A deterministic stand-in for Black that records argv and echoes stdin. */
export async function createFakeBlack(
  options: { version?: string; exitCode?: number } = {},
): Promise<FakeBlack> {
  const dir = await mkdtemp(join(tmpdir(), "fake-black-"));
  const command = join(dir, "black");
  const argsLog = join(dir, "args.log");
  const version = options.version ?? "99.1.0";
  const lines = [
    "#!/bin/sh",
    'case " $* " in',
    `  *" --version "*) printf 'black, %s (compiled: no)\\n' ${shellQuote(version)}; exit 0 ;;`,
    "esac",
    `for arg in "$@"; do printf '%s\\n' "$arg" >> ${shellQuote(argsLog)}; done`,
    "cat",
  ];
  if (options.exitCode !== undefined && options.exitCode !== 0) {
    lines.push(`exit ${options.exitCode}`);
  }

  await writeFile(command, `${lines.join("\n")}\n`, { mode: 0o755 });
  await chmod(command, 0o755);

  return {
    command,
    argsLog,
    dir,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
