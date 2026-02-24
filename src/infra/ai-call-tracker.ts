import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

type Pricing = {
  input: number;
  output: number;
};

type PricingConfig = {
  version: number;
  updatedAt: string;
  default: Pricing;
  models: Record<string, Pricing>;
  patterns: Record<string, string[]>;
};

export type AiApiCallLogEntry = {
  timestamp: string;
  model: string;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  taskType: string;
  description: string;
  costEstimate: number;
  source: string;
};

export type AppendAiApiCallParams = {
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
  };
  taskType?: string;
  description?: string;
  source?: string;
  mirrorToSqlite?: boolean;
};

const TRACKER_DIR = path.join(resolveStateDir(), "usage-tracker");
const PRICING_CONFIG_PATH = path.join(TRACKER_DIR, "pricing.json");
const JSONL_PATH = path.join(TRACKER_DIR, "ai-api-calls.jsonl");
const SQLITE_PATH = path.join(TRACKER_DIR, "ai-api-calls.sqlite");

const DEFAULT_PRICING: PricingConfig = {
  version: 1,
  updatedAt: "2026-02-23",
  default: { input: 1, output: 3 },
  models: {
    "anthropic-opus": { input: 15, output: 75 },
    "anthropic-sonnet": { input: 3, output: 15 },
    "anthropic-haiku": { input: 0.8, output: 4 },
    "openai-gpt-4": { input: 30, output: 60 },
    "openai-gpt-4-turbo": { input: 10, output: 30 },
    "openai-gpt-3.5-turbo": { input: 0.5, output: 1.5 },
    "openai-o1": { input: 15, output: 60 },
    "google-gemini-pro": { input: 10, output: 30 },
    "google-gemini-flash": { input: 0.3, output: 1.2 },
    "google-gemini-1.5-pro": { input: 1.25, output: 5 },
    "xai-grok": { input: 2, output: 10 },
  },
  patterns: {
    "anthropic-opus": ["opus", "claude-3-opus", "claude opus"],
    "anthropic-sonnet": ["sonnet", "claude-3-sonnet", "claude sonnet"],
    "anthropic-haiku": ["haiku", "claude-3-haiku", "claude haiku"],
    "openai-gpt-4": ["gpt-4", "gpt4"],
    "openai-gpt-4-turbo": ["gpt-4-turbo", "gpt4-turbo"],
    "openai-gpt-3.5-turbo": ["gpt-3.5-turbo", "gpt-35-turbo", "gpt3.5"],
    "openai-o1": ["o1"],
    "google-gemini-pro": ["gemini pro"],
    "google-gemini-flash": ["gemini flash"],
    "google-gemini-1.5-pro": ["gemini 1.5 pro", "gemini-1.5-pro"],
    "xai-grok": ["grok"],
  },
};

function normalizePositiveInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.round(value);
}

function isPricing(value: unknown): value is Pricing {
  if (!value || typeof value !== "object") {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.input === "number" &&
    Number.isFinite(rec.input) &&
    rec.input >= 0 &&
    typeof rec.output === "number" &&
    Number.isFinite(rec.output) &&
    rec.output >= 0
  );
}

function isPricingConfig(value: unknown): value is PricingConfig {
  if (!value || typeof value !== "object") {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.version !== "number" ||
    typeof rec.updatedAt !== "string" ||
    !isPricing(rec.default) ||
    !rec.models ||
    typeof rec.models !== "object" ||
    !rec.patterns ||
    typeof rec.patterns !== "object"
  ) {
    return false;
  }

  for (const item of Object.values(rec.models as Record<string, unknown>)) {
    if (!isPricing(item)) {
      return false;
    }
  }
  for (const item of Object.values(rec.patterns as Record<string, unknown>)) {
    if (!Array.isArray(item) || item.some((part) => typeof part !== "string")) {
      return false;
    }
  }
  return true;
}

async function ensurePricingConfigFile(): Promise<void> {
  await fs.promises.mkdir(TRACKER_DIR, { recursive: true });
  try {
    await fs.promises.access(PRICING_CONFIG_PATH, fs.constants.F_OK);
  } catch {
    await fs.promises.writeFile(
      PRICING_CONFIG_PATH,
      `${JSON.stringify(DEFAULT_PRICING, null, 2)}\n`,
      "utf-8",
    );
  }
}

async function loadPricingConfig(): Promise<PricingConfig> {
  await ensurePricingConfigFile();
  try {
    const raw = await fs.promises.readFile(PRICING_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isPricingConfig(parsed)) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return DEFAULT_PRICING;
}

function resolvePricingForModel(model: string | undefined, pricing: PricingConfig): Pricing {
  const modelName = (model ?? "unknown-model").trim().toLowerCase();
  if (!modelName) {
    return pricing.default;
  }

  const exact = pricing.models[modelName];
  if (exact) {
    return exact;
  }

  for (const [pricingKey, patterns] of Object.entries(pricing.patterns)) {
    if (patterns.some((pattern) => modelName.includes(pattern.toLowerCase()))) {
      return pricing.models[pricingKey] ?? pricing.default;
    }
  }

  return pricing.default;
}

function estimateCostUsd(params: {
  inputTokens: number;
  outputTokens: number;
  pricing: Pricing;
}): number {
  const inputCost = (params.inputTokens / 1_000_000) * params.pricing.input;
  const outputCost = (params.outputTokens / 1_000_000) * params.pricing.output;
  return Number((inputCost + outputCost).toFixed(8));
}

function shouldMirrorToSqlite(explicit?: boolean): boolean {
  if (typeof explicit === "boolean") {
    return explicit;
  }
  return process.env.OPENCLAW_AI_USAGE_SQLITE === "1";
}

function mirrorLogEntryToSqlite(entry: AiApiCallLogEntry): void {
  try {
    fs.mkdirSync(TRACKER_DIR, { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(SQLITE_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_api_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        description TEXT NOT NULL,
        cost_estimate REAL NOT NULL,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_api_calls_timestamp ON ai_api_calls(timestamp);
      CREATE INDEX IF NOT EXISTS idx_ai_api_calls_model ON ai_api_calls(model);
      CREATE INDEX IF NOT EXISTS idx_ai_api_calls_task_type ON ai_api_calls(task_type);
    `);
    const stmt = db.prepare(
      `INSERT INTO ai_api_calls (
        timestamp, model, input_tokens, output_tokens, total_tokens, task_type, description, cost_estimate, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      entry.timestamp,
      entry.model,
      entry.tokens.input,
      entry.tokens.output,
      entry.tokens.total,
      entry.taskType,
      entry.description,
      entry.costEstimate,
      entry.source,
    );
    db.close();
  } catch {
    // SQLite mirroring is optional; do not fail the call pipeline.
  }
}

export function resolveAiCallTrackerPaths() {
  return {
    dirPath: TRACKER_DIR,
    pricingConfigPath: PRICING_CONFIG_PATH,
    jsonlPath: JSONL_PATH,
    sqlitePath: SQLITE_PATH,
  };
}

export async function appendAiApiCallLog(
  params: AppendAiApiCallParams,
): Promise<AiApiCallLogEntry> {
  const pricing = await loadPricingConfig();

  const inputTokens = normalizePositiveInt(params.usage?.input);
  const outputTokens = normalizePositiveInt(params.usage?.output);
  const totalTokens = Math.max(
    normalizePositiveInt(params.usage?.total),
    inputTokens + outputTokens,
  );

  const resolvedModel = (params.model ?? "unknown-model").trim() || "unknown-model";
  const modelPricing = resolvePricingForModel(resolvedModel, pricing);
  const costEstimate = estimateCostUsd({
    inputTokens,
    outputTokens,
    pricing: modelPricing,
  });

  const entry: AiApiCallLogEntry = {
    timestamp: new Date().toISOString(),
    model: resolvedModel,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens,
    },
    taskType: (params.taskType ?? "general").trim() || "general",
    description: (params.description ?? "ai-api-call").trim() || "ai-api-call",
    costEstimate,
    source: (params.source ?? "openclaw").trim() || "openclaw",
  };

  await fs.promises.mkdir(TRACKER_DIR, { recursive: true });
  await fs.promises.appendFile(JSONL_PATH, `${JSON.stringify(entry)}\n`, "utf-8");

  if (shouldMirrorToSqlite(params.mirrorToSqlite)) {
    mirrorLogEntryToSqlite(entry);
  }

  return entry;
}
