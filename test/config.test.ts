import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_DOCS_DIR, DEFAULT_STATE_DIR, loadConfig, resolveDocsDir } from "../src/config.ts";

const ENV_KEYS = [
  "H2_CHANNEL_MODEL",
  "H2_SOLVER_MODEL",
  "H2_PI_BIN",
  "H2_K",
  "H2_MODE",
  "H2_WALL_SECONDS",
  "H2_DOCS_DIR",
];

test("publish.docsDir defaults to docs; H2_DOCS_DIR overrides it", () => {
  withEnv({}, () => {
    const cfg = loadConfig(tempState());
    assert.equal(cfg.publish, undefined, "no publish block unless configured");
    assert.equal(resolveDocsDir(cfg), DEFAULT_DOCS_DIR);
    assert.equal(DEFAULT_DOCS_DIR, "docs");
  });
  withEnv({H2_DOCS_DIR: "/tmp/elsewhere"}, () => {
    const cfg = loadConfig(tempState());
    assert.deepEqual(cfg.publish, {docsDir: "/tmp/elsewhere"});
    assert.equal(resolveDocsDir(cfg), "/tmp/elsewhere");
  });
});

test("config.json publish.docsDir merges over the default; env wins over the file", () => {
  const dir = tempState();
  writeFileSync(join(dir, "config.json"), JSON.stringify({publish: {docsDir: "site"}}));
  withEnv({}, () => {
    assert.deepEqual(loadConfig(dir).publish, {docsDir: "site"});
  });
  withEnv({H2_DOCS_DIR: "elsewhere"}, () => {
    assert.deepEqual(loadConfig(dir).publish, {docsDir: "elsewhere"});
  });
  // publish: {} is legal and resolves to the default docsDir.
  writeFileSync(join(dir, "config.json"), JSON.stringify({publish: {}}));
  withEnv({}, () => {
    assert.deepEqual(loadConfig(dir).publish, {});
    assert.equal(resolveDocsDir(loadConfig(dir)), "docs");
  });
});

test("invalid publish values throw with the source and key named", () => {
  withEnv({}, () => {
    const dir = tempState();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({publish: "docs"}));
    assert.throws(
      () => loadConfig(dir),
      (e: Error) => e.message.includes(path) && e.message.includes("publish"),
    );
    writeFileSync(path, JSON.stringify({publish: {docsDir: 5}}));
    assert.throws(
      () => loadConfig(dir),
      (e: Error) => e.message.includes("publish.docsDir") && e.message.includes("5"),
    );
  });
  withEnv({H2_DOCS_DIR: "  "}, () => {
    assert.throws(
      () => loadConfig(tempState()),
      (e: Error) => e.message.includes("H2_DOCS_DIR"),
    );
  });
});

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "h2-cfg-"));
}

/** Run fn with exactly the given H2_* env set; every other H2_* var is cleared, and all
 * prior values are restored afterwards so tests never leak into each other. */
function withEnv(entries: Record<string, string>, fn: () => void): void {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(entries)) process.env[k] = v;
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("DEFAULT_STATE_DIR is <cwd>/.harness2", () => {
  assert.ok(isAbsolute(DEFAULT_STATE_DIR));
  assert.ok(DEFAULT_STATE_DIR.endsWith(join(".harness2")));
});

test("loadConfig returns the documented defaults with no file and no env", () => {
  withEnv({}, () => {
    const dir = tempState();
    assert.deepEqual(loadConfig(dir), {
      stateDir: dir,
      channelModel: "",
      solverModel: "",
      k: 1,
      mode: "parallel",
      wallSeconds: 900,
      piBin: "pi",
    });
  });
});

test("a partial config.json merges over the defaults", () => {
  withEnv({}, () => {
    const dir = tempState();
    writeFileSync(join(dir, "config.json"), JSON.stringify({k: 3, piBin: "stub-pi"}));
    assert.deepEqual(loadConfig(dir), {
      stateDir: dir,
      channelModel: "",
      solverModel: "",
      k: 3,
      mode: "parallel",
      wallSeconds: 900,
      piBin: "stub-pi",
    });
  });
});

test("env overrides win over config.json and defaults", () => {
  withEnv(
    {
      H2_CHANNEL_MODEL: "anthropic/claude-x",
      H2_SOLVER_MODEL: "openai/gpt-y",
      H2_PI_BIN: "pi-dev",
      H2_K: "5",
      H2_MODE: "sequential",
      H2_WALL_SECONDS: "12.5",
    },
    () => {
      const dir = tempState();
      writeFileSync(join(dir, "config.json"), JSON.stringify({k: 3, mode: "parallel"}));
      const cfg = loadConfig(dir);
      assert.equal(cfg.channelModel, "anthropic/claude-x");
      assert.equal(cfg.solverModel, "openai/gpt-y");
      assert.equal(cfg.piBin, "pi-dev");
      assert.equal(cfg.k, 5);
      assert.equal(cfg.mode, "sequential");
      assert.equal(cfg.wallSeconds, 12.5);
    },
  );
});

test("invalid H2_K values throw with the variable named", () => {
  for (const bad of ["0", "-2", "abc", "2.5", ""]) {
    withEnv({H2_K: bad}, () => {
      assert.throws(() => loadConfig(tempState()), (e: Error) => {
        return e.message.includes("H2_K") && e.message.includes(JSON.stringify(bad));
      });
    });
  }
});

test("invalid H2_MODE and H2_WALL_SECONDS values throw with the variable named", () => {
  withEnv({H2_MODE: "both"}, () => {
    assert.throws(() => loadConfig(tempState()), (e: Error) => e.message.includes("H2_MODE"));
  });
  for (const bad of ["0", "-1", "abc"]) {
    withEnv({H2_WALL_SECONDS: bad}, () => {
      assert.throws(
        () => loadConfig(tempState()),
        (e: Error) => e.message.includes("H2_WALL_SECONDS"),
      );
    });
  }
});

test("invalid config.json values throw with the file and key named", () => {
  withEnv({}, () => {
    const dir = tempState();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({k: 0}));
    assert.throws(
      () => loadConfig(dir),
      (e: Error) => e.message.includes(path) && e.message.includes("k"),
    );
    writeFileSync(path, JSON.stringify({mode: "both"}));
    assert.throws(() => loadConfig(dir), (e: Error) => e.message.includes("mode"));
    writeFileSync(path, "{nope");
    assert.throws(() => loadConfig(dir), (e: Error) => e.message.includes("not valid JSON"));
    writeFileSync(path, "[]");
    assert.throws(() => loadConfig(dir), (e: Error) => e.message.includes("one JSON object"));
  });
});
