import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { describeSupport, formatCode } from "../src/formatter.js";
import { PluginManager } from "../src/plugin-manager.js";
import { BlackFormatter } from "../src/python.js";
import { makeConfig } from "./helpers/config.js";
import { createFakeBlack } from "./helpers/fake-black.js";

const DEV_NULL = process.platform === "win32" ? "NUL" : "/dev/null";

async function setup(blackCommand: string) {
  const config = await makeConfig("https://registry.npmjs.org/", { blackCommand });
  return { config, manager: new PluginManager({ config }) };
}

test("formats Python files through Black with validated argv", async () => {
  const fake = await createFakeBlack();
  try {
    const { manager } = await setup(fake.command);
    const black = new BlackFormatter(fake.command, 5_000);
    const result = await formatCode(
      {
        filename: "script.py",
        code: "x='a'\n",
        config: {
          lineWidth: 100,
          black: {
            skipStringNormalization: true,
            preview: true,
            targetVersion: ["py311", "py312"],
          },
        },
      },
      manager,
      black,
    );

    assert.equal(result.formatted, "x='a'\n");
    assert.deepEqual(result.plugins, []);
    assert.deepEqual((await readFile(fake.argsLog, "utf8")).trim().split("\n"), [
      "--quiet",
      "--no-cache",
      "--config",
      DEV_NULL,
      "--line-length=100",
      "--skip-string-normalization",
      "--preview",
      "--target-version=py311",
      "--target-version=py312",
      "--stdin-filename",
      "script.py",
      "-",
    ]);
  } finally {
    await fake.close();
  }
});

test("formats stub files with pyi mode and rejects unknown Black options", async () => {
  const fake = await createFakeBlack();
  try {
    const { manager } = await setup(fake.command);
    const black = new BlackFormatter(fake.command, 5_000);

    await formatCode(
      {
        filename: "types.pyi",
        code: "x: int = 1\n",
        config: {
          black: { skipMagicTrailingComma: true, unstable: true, pyi: true },
        },
      },
      manager,
      black,
    );

    const args = (await readFile(fake.argsLog, "utf8")).trim().split("\n");
    assert.ok(args.includes("--pyi"));
    assert.ok(args.includes("--skip-magic-trailing-comma"));
    assert.ok(args.includes("--unstable"));

    await assert.rejects(
      formatCode(
        { filename: "a.py", code: "x=1", config: { black: { line_length: 99 } } },
        manager,
        black,
      ),
      /Unknown Black option "line_length"/,
    );
  } finally {
    await fake.close();
  }
});

test("does not interpret filename contents as shell input", async () => {
  const fake = await createFakeBlack();
  const marker = join(fake.dir, "pwned");
  try {
    const { manager } = await setup(fake.command);
    const black = new BlackFormatter(fake.command, 5_000);
    const filename = `x'; touch ${marker}; #.py`;

    await formatCode({ filename, code: "x=1", config: {} }, manager, black);

    const args = (await readFile(fake.argsLog, "utf8")).trim().split("\n");
    assert.ok(args.includes(filename));
    await assert.rejects(access(marker));
  } finally {
    await fake.close();
  }
});

test("rejects Prettier plugins for Python files", async () => {
  const fake = await createFakeBlack();
  try {
    const { manager } = await setup(fake.command);
    const black = new BlackFormatter(fake.command, 5_000);

    await assert.rejects(
      formatCode(
        { filename: "a.py", code: "x=1", plugins: ["test-plugin"] },
        manager,
        black,
      ),
      /Prettier plugins cannot be applied to Python files/,
    );
    await assert.rejects(access(fake.argsLog));
  } finally {
    await fake.close();
  }
});

test("non-Python files stay on Prettier without invoking Black", async () => {
  const fake = await createFakeBlack();
  try {
    const { manager } = await setup(fake.command);
    const black = new BlackFormatter(fake.command, 5_000);
    const result = await formatCode(
      { filename: "a.js", code: "const a=1", config: { black: { lineLength: 10 } } },
      manager,
      black,
    );

    assert.equal(result.formatted, "const a = 1;\n");
    await assert.rejects(access(fake.argsLog));
  } finally {
    await fake.close();
  }
});

test("support report includes Python only when Black is available", async () => {
  const fake = await createFakeBlack({ version: "99.1.0" });
  try {
    const { manager } = await setup(fake.command);
    const available = await describeSupport(manager, [], new BlackFormatter(fake.command, 5_000));

    assert.ok(available.extensions.includes(".py"));
    assert.ok(available.extensions.includes(".pyi"));
    assert.ok(
      available.languages.some(
        (language) =>
          language.name === "Python (Black)" &&
          language.extensions.includes(".py") &&
          language.parsers.includes("black"),
      ),
    );
    assert.deepEqual(
      available.formatters.find((formatter) => formatter.name === "black"),
      { name: "black", version: "99.1.0", extensions: [".py", ".pyi"] },
    );

    const unavailable = await describeSupport(
      manager,
      [],
      new BlackFormatter(join(fake.dir, "does-not-exist"), 100),
    );
    assert.ok(!unavailable.extensions.includes(".py"));
    assert.deepEqual(
      unavailable.formatters.map((formatter) => formatter.name),
      ["prettier"],
    );
  } finally {
    await fake.close();
  }
});
