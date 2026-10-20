/** Configuration for the harness² surface: fixed defaults, optionally overlaid by
 * <stateDir>/config.json, then by H2_* environment variables (env wins). Invalid values
 * always throw with the offending source named, so a bad key can never silently become a
 * zero or fall back to a default the user did not choose. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The tunable subset of HarnessConfig, written verbatim as the h2:init seed config.json.
 * stateDir is positional (where the config lives) and never appears in the file. */
export const CONFIG_DEFAULTS: Omit<HarnessConfig, "stateDir"> = {
  channelModel: "",
  solverModel: "",
  k: 1,
  mode: "parallel",
  wallSeconds: 900,
  piBin: "pi",
};

/** Default state root: <cwd>/.harness2. */
export const DEFAULT_STATE_DIR = join(process.cwd(), ".harness2");

export interface HarnessConfig {
  /** State root: harness/, runs/, library/, ledger.jsonl and config.json live here. */
  stateDir: string;
  /** Model pattern for channel calls; "" means pi's configured default. */
  channelModel: string;
  /** Reserved for a future solver lane; "" means pi's configured default. */
  solverModel: string;
  /** Slots per lens (parallel) or steps (sequential). */
  k: number;
  /** Candidate strategy: width (parallel) or depth (sequential). */
  mode: "parallel" | "sequential";
  /** Wall budget per channel call, in seconds. */
  wallSeconds: number;
  /** pi binary invoked for channel calls and probes. */
  piBin: string;
}

function fail(source: string, key: string, value: unknown, want: string): Error {
  return new Error(`${source}: ${key} is ${JSON.stringify(value)}; want ${want}`);
}

function asString(source: string, key: string, value: unknown): string {
  if (typeof value !== "string") throw fail(source, key, value, "a string");
  return value;
}

function asPositiveInt(source: string, key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw fail(source, key, value, "an integer > 0");
  }
  return value;
}

function asPositiveNumber(source: string, key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw fail(source, key, value, "a finite number > 0");
  }
  return value;
}

function asMode(source: string, key: string, value: unknown): "parallel" | "sequential" {
  if (value !== "parallel" && value !== "sequential") {
    throw fail(source, key, value, '"parallel" or "sequential"');
  }
  return value;
}

type Validator<T> = (source: string, key: string, value: unknown) => T;

const FILE_KEYS: Record<string, Validator<string | number | "parallel" | "sequential">> = {
  channelModel: asString,
  solverModel: asString,
  k: asPositiveInt,
  mode: asMode,
  wallSeconds: asPositiveNumber,
  piBin: asString,
};

const ENV_KEYS: Record<string, Validator<string | number | "parallel" | "sequential">> = {
  H2_CHANNEL_MODEL: asString,
  H2_SOLVER_MODEL: asString,
  H2_PI_BIN: asString,
  // Numeric env validators parse the raw string themselves so failures name the exact
  // bytes the user wrote, never a derived NaN or 0.
  H2_K: (source, key, raw) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n) || n <= 0) {
      throw fail(source, key, raw, "an integer > 0");
    }
    return n;
  },
  H2_MODE: asMode,
  H2_WALL_SECONDS: (source, key, raw) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) {
      throw fail(source, key, raw, "a finite number > 0");
    }
    return n;
  },
};

/** Load the effective configuration for one state directory: defaults, then config.json,
 * then env. Unknown config.json keys are ignored (forward compatibility); known keys with
 * invalid values throw, naming the file or variable at fault. */
export function loadConfig(stateDir: string = DEFAULT_STATE_DIR): HarnessConfig {
  const values: Omit<HarnessConfig, "stateDir"> = {...CONFIG_DEFAULTS};
  const path = join(stateDir, "config.json");
  let rawFile: string;
  try {
    rawFile = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    rawFile = "";
  }
  if (rawFile !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawFile);
    } catch (e) {
      throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path} must contain one JSON object of config keys`);
    }
    const obj = parsed as Record<string, unknown>;
    for (const [key, validate] of Object.entries(FILE_KEYS)) {
      if (key in obj) {
        (values as Record<string, unknown>)[key] = validate(path, key, obj[key]);
      }
    }
  }
  for (const [key, validate] of Object.entries(ENV_KEYS)) {
    const raw = process.env[key];
    if (raw !== undefined) {
      (values as Record<string, unknown>)[ENV_TO_CONFIG[key]!] = validate(`env ${key}`, key, raw);
    }
  }
  return {stateDir, ...values};
}

const ENV_TO_CONFIG: Record<string, keyof Omit<HarnessConfig, "stateDir">> = {
  H2_CHANNEL_MODEL: "channelModel",
  H2_SOLVER_MODEL: "solverModel",
  H2_PI_BIN: "piBin",
  H2_K: "k",
  H2_MODE: "mode",
  H2_WALL_SECONDS: "wallSeconds",
};
