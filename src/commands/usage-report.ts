import fs from "node:fs";
import readline from "node:readline";
import type { RuntimeEnv } from "../runtime.js";
import { resolveAiCallTrackerPaths, type AiApiCallLogEntry } from "../infra/ai-call-tracker.js";

type UsageReportOptions = {
  days?: number;
  model?: string;
  taskType?: string;
  weekly?: boolean;
  json?: boolean;
};

type Totals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

type AggregatedRow = Totals & { key: string };

const FRONTIER_MODELS = ["opus", "gpt-4", "gpt4"];
const SIMPLE_TASK_HINTS = ["format", "formatting", "extract", "extraction", "cleanup", "rewrite"];
const RESEARCH_HINTS = ["research", "x-research"];

function emptyTotals(): Totals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function addToTotals(totals: Totals, entry: AiApiCallLogEntry): void {
  totals.calls += 1;
  totals.inputTokens += entry.tokens.input;
  totals.outputTokens += entry.tokens.output;
  totals.totalTokens += entry.tokens.total;
  totals.cost += entry.costEstimate;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatNum(value: number): string {
  return value.toLocaleString("en-US");
}

function roundCost(value: number): number {
  return Number(value.toFixed(8));
}

function isFrontierModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return FRONTIER_MODELS.some((hint) => normalized.includes(hint));
}

function isSimpleTask(entry: AiApiCallLogEntry): boolean {
  const task = entry.taskType.toLowerCase();
  const description = entry.description.toLowerCase();
  const shortInput = entry.tokens.input <= 800;
  const hintMatched =
    SIMPLE_TASK_HINTS.some((hint) => task.includes(hint)) ||
    SIMPLE_TASK_HINTS.some((hint) => description.includes(hint));
  return shortInput && hintMatched;
}

async function loadEntries(days: number): Promise<AiApiCallLogEntry[]> {
  const { jsonlPath } = resolveAiCallTrackerPaths();
  if (!fs.existsSync(jsonlPath)) {
    return [];
  }

  const sinceMs = Date.now() - (days - 1) * 24 * 60 * 60 * 1000;
  const fileStream = fs.createReadStream(jsonlPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  const entries: AiApiCallLogEntry[] = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const entry = JSON.parse(trimmed) as AiApiCallLogEntry;
      const ts = new Date(entry.timestamp).getTime();
      if (!Number.isFinite(ts) || ts < sinceMs) {
        continue;
      }
      entries.push(entry);
    } catch {
      // Ignore malformed lines.
    }
  }
  return entries;
}

function applyFilters(
  entries: AiApiCallLogEntry[],
  opts: { model?: string; taskType?: string },
): AiApiCallLogEntry[] {
  const modelFilter = opts.model?.trim().toLowerCase();
  const taskFilter = opts.taskType?.trim().toLowerCase();
  return entries.filter((entry) => {
    if (modelFilter && !entry.model.toLowerCase().includes(modelFilter)) {
      return false;
    }
    if (taskFilter && !entry.taskType.toLowerCase().includes(taskFilter)) {
      return false;
    }
    return true;
  });
}

function aggregateBy(
  entries: AiApiCallLogEntry[],
  keyFn: (entry: AiApiCallLogEntry) => string,
): AggregatedRow[] {
  const map = new Map<string, Totals>();
  for (const entry of entries) {
    const key = keyFn(entry);
    const bucket = map.get(key) ?? emptyTotals();
    addToTotals(bucket, entry);
    map.set(key, bucket);
  }
  return Array.from(map.entries())
    .map(([key, totals]) => ({ key, ...totals, cost: roundCost(totals.cost) }))
    .toSorted((a, b) => b.cost - a.cost);
}

function dayKey(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) {
    return "unknown";
  }
  return dt.toISOString().slice(0, 10);
}

function aggregateByDay(entries: AiApiCallLogEntry[]): AggregatedRow[] {
  return aggregateBy(entries, (entry) => dayKey(entry.timestamp))
    .filter((row) => row.key !== "unknown")
    .toSorted((a, b) => a.key.localeCompare(b.key));
}

function buildTrendLines(entries: AiApiCallLogEntry[], weekly: boolean): AggregatedRow[] {
  if (!weekly) {
    return aggregateByDay(entries);
  }
  return aggregateBy(entries, (entry) => {
    const dt = new Date(entry.timestamp);
    if (Number.isNaN(dt.getTime())) {
      return "unknown";
    }
    const copy = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    const day = copy.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    copy.setUTCDate(copy.getUTCDate() + diff);
    return copy.toISOString().slice(0, 10);
  }).toSorted((a, b) => a.key.localeCompare(b.key));
}

function buildSuggestions(entries: AiApiCallLogEntry[], totals: Totals): string[] {
  const suggestions: string[] = [];

  const frontierSimple = entries.filter(
    (entry) => isFrontierModel(entry.model) && isSimpleTask(entry),
  );
  if (frontierSimple.length > 0) {
    const byTask = aggregateBy(frontierSimple, (entry) => entry.taskType).slice(0, 3);
    for (const row of byTask) {
      suggestions.push(
        `Task \`${row.key}\` uses frontier models for simple/short requests. Consider routing to a cheaper model.`,
      );
    }
  }

  const byTask = aggregateBy(entries, (entry) => entry.taskType);
  for (const row of byTask) {
    if (totals.cost <= 0) {
      break;
    }
    const pct = (row.cost / totals.cost) * 100;
    if (pct > 25) {
      suggestions.push(
        `Task \`${row.key}\` is ${pct.toFixed(1)}% of spend (${formatUsd(row.cost)}). Mark it as an optimization candidate.`,
      );
    }
  }

  const repeated = aggregateBy(
    entries.filter((entry) =>
      RESEARCH_HINTS.some(
        (hint) =>
          entry.taskType.toLowerCase().includes(hint) ||
          entry.description.toLowerCase().includes(hint),
      ),
    ),
    (entry) => `${entry.taskType}::${entry.description.toLowerCase().slice(0, 80)}`,
  )
    .filter((row) => row.calls >= 3)
    .slice(0, 3);
  if (repeated.length > 0) {
    suggestions.push(
      "Repeated research-like queries detected. Add caching (prompt+params hash, 24h TTL) to avoid duplicate calls.",
    );
  }

  if (suggestions.length === 0) {
    suggestions.push("No major routing/caching issues detected in the selected window.");
  }
  return suggestions;
}

function renderSectionRows(rows: AggregatedRow[], limit?: number): string[] {
  const sliced = typeof limit === "number" ? rows.slice(0, limit) : rows;
  if (sliced.length === 0) {
    return ["- none"];
  }
  return sliced.map(
    (row) =>
      `- ${row.key}: calls ${formatNum(row.calls)}, tokens ${formatNum(row.totalTokens)} (in ${formatNum(row.inputTokens)} / out ${formatNum(row.outputTokens)}), cost ${formatUsd(row.cost)}`,
  );
}

function renderMarkdown(params: {
  entries: AiApiCallLogEntry[];
  opts: UsageReportOptions;
}): string {
  const totals = emptyTotals();
  for (const entry of params.entries) {
    addToTotals(totals, entry);
  }
  totals.cost = roundCost(totals.cost);

  const byModel = aggregateBy(params.entries, (entry) => entry.model);
  const byTask = aggregateBy(params.entries, (entry) => entry.taskType);
  const byDay = aggregateByDay(params.entries).slice(-10);
  const trend30 = buildTrendLines(
    params.entries.filter(
      (entry) => Date.now() - new Date(entry.timestamp).getTime() <= 30 * 24 * 60 * 60 * 1000,
    ),
    params.opts.weekly ?? false,
  );
  const trend90 = buildTrendLines(
    params.entries.filter(
      (entry) => Date.now() - new Date(entry.timestamp).getTime() <= 90 * 24 * 60 * 60 * 1000,
    ),
    params.opts.weekly ?? false,
  );
  const suggestions = buildSuggestions(params.entries, totals);

  const lines: string[] = [];
  lines.push("# AI API Usage Report");
  lines.push("");
  lines.push(`Window: last ${params.opts.days} day(s)`);
  if (params.opts.model) {
    lines.push(`Model filter: ${params.opts.model}`);
  }
  if (params.opts.taskType) {
    lines.push(`Task type filter: ${params.opts.taskType}`);
  }
  lines.push("");
  lines.push("## Overall summary");
  lines.push(`- total calls: ${formatNum(totals.calls)}`);
  lines.push(
    `- total tokens: ${formatNum(totals.totalTokens)} (input ${formatNum(totals.inputTokens)}, output ${formatNum(totals.outputTokens)})`,
  );
  lines.push(`- total cost: ${formatUsd(totals.cost)}`);
  lines.push("");
  lines.push("## By model (cost desc)");
  lines.push(...renderSectionRows(byModel));
  lines.push("");
  lines.push("## By task type (cost desc)");
  lines.push(...renderSectionRows(byTask));
  lines.push("");
  lines.push("## By day (last 10 days)");
  lines.push(...renderSectionRows(byDay));
  lines.push("");
  lines.push(`## Trend (${params.opts.weekly ? "weekly" : "daily"}) - 30 days`);
  lines.push(...renderSectionRows(trend30));
  lines.push("");
  lines.push(`## Trend (${params.opts.weekly ? "weekly" : "daily"}) - 90 days`);
  lines.push(...renderSectionRows(trend90));
  lines.push("");
  lines.push("## Routing suggestions");
  for (const suggestion of suggestions) {
    lines.push(`- ${suggestion}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function usageReportCommand(
  opts: UsageReportOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const days =
    Number.isFinite(opts.days) && (opts.days ?? 0) > 0 ? Math.floor(opts.days as number) : 30;
  const loaded = await loadEntries(days);
  const entries = applyFilters(loaded, {
    model: opts.model,
    taskType: opts.taskType,
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          windowDays: days,
          filters: {
            model: opts.model ?? null,
            taskType: opts.taskType ?? null,
          },
          weeklyTrend: Boolean(opts.weekly),
          entries,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(
    renderMarkdown({
      entries,
      opts: { ...opts, days },
    }),
  );
}
