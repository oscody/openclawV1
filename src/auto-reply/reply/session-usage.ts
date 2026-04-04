import { setCliSessionId } from "../../agents/cli-session.js";
import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  type NormalizedUsage,
} from "../../agents/usage.js";
import {
  type SessionSystemPromptReport,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { appendAiApiCallLog } from "../../infra/ai-call-tracker.js";

function applyCliSessionIdToSessionPatch(
  params: { cliSessionId?: string; providerUsed?: string },
  entry: SessionEntry,
  patch: Partial<SessionEntry>,
): Partial<SessionEntry> {
  const cliProvider = params.providerUsed ?? entry.modelProvider;
  if (params.cliSessionId && cliProvider) {
    const nextEntry: SessionEntry = { ...entry, ...patch };
    setCliSessionId(nextEntry, cliProvider, params.cliSessionId);
    return {
      ...patch,
      cliSessionIds: nextEntry.cliSessionIds,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }
  return patch;
}

export async function persistSessionUsageUpdate(params: {
  storePath?: string;
  sessionKey?: string;
  usage?: NormalizedUsage;
  /**
   * Usage from the last individual API call (not accumulated). When provided,
   * this is used for `totalTokens` instead of the accumulated `usage` so that
   * context-window utilization reflects the actual current context size rather
   * than the sum of input tokens across all API calls in the run.
   */
  lastCallUsage?: NormalizedUsage;
  modelUsed?: string;
  providerUsed?: string;
  contextTokensUsed?: number;
  promptTokens?: number;
  systemPromptReport?: SessionSystemPromptReport;
  cliSessionId?: string;
  logLabel?: string;
  taskType?: string;
  description?: string;
  source?: string;
}): Promise<void> {
  const { storePath, sessionKey } = params;

  const label = params.logLabel ? `${params.logLabel} ` : "";
  const hasUsage = hasNonzeroUsage(params.usage);
  const hasPromptTokens =
    typeof params.promptTokens === "number" &&
    Number.isFinite(params.promptTokens) &&
    params.promptTokens > 0;
  const hasFreshContextSnapshot = Boolean(params.lastCallUsage) || hasPromptTokens;

  if (hasUsage || hasFreshContextSnapshot) {
    try {
      const input = params.usage?.input ?? 0;
      const output = params.usage?.output ?? 0;
      const total = params.usage?.total ?? input + output;
      await appendAiApiCallLog({
        model: params.modelUsed,
        usage: { input, output, total },
        taskType: params.taskType,
        description: params.description ?? `${label.trim() || "reply"} usage update`,
        source: params.source ?? "openclaw-session-usage",
      });
    } catch (err) {
      logVerbose(`failed to append ai-call usage log: ${String(err)}`);
    }

    if (storePath && sessionKey) {
      try {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async (entry) => {
            const resolvedContextTokens = params.contextTokensUsed ?? entry.contextTokens;
            const usageForContext = params.lastCallUsage ?? (hasUsage ? params.usage : undefined);
            const totalTokens = hasFreshContextSnapshot
              ? deriveSessionTotalTokens({
                  usage: usageForContext,
                  contextTokens: resolvedContextTokens,
                  promptTokens: params.promptTokens,
                })
              : undefined;
            const patch: Partial<SessionEntry> = {
              modelProvider: params.providerUsed ?? entry.modelProvider,
              model: params.modelUsed ?? entry.model,
              contextTokens: resolvedContextTokens,
              systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
              updatedAt: Date.now(),
            };
            if (hasUsage) {
              patch.inputTokens = params.usage?.input ?? 0;
              patch.outputTokens = params.usage?.output ?? 0;
              patch.cacheRead = params.usage?.cacheRead ?? 0;
              patch.cacheWrite = params.usage?.cacheWrite ?? 0;
            }
            patch.totalTokens = totalTokens;
            patch.totalTokensFresh = typeof totalTokens === "number";
            return applyCliSessionIdToSessionPatch(params, entry, patch);
          },
        });
      } catch (err) {
        logVerbose(`failed to persist ${label}usage update: ${String(err)}`);
      }
    } else {
      logVerbose(`skipping ${label}usage session-store update: missing storePath/sessionKey`);
    }
    return;
  }

  if (params.modelUsed || params.contextTokensUsed) {
    if (!storePath || !sessionKey) {
      logVerbose(
        `skipping ${label}model/context session-store update: missing storePath/sessionKey`,
      );
      return;
    }
    try {
      await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async (entry) => {
          const patch: Partial<SessionEntry> = {
            modelProvider: params.providerUsed ?? entry.modelProvider,
            model: params.modelUsed ?? entry.model,
            contextTokens: params.contextTokensUsed ?? entry.contextTokens,
            systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
            updatedAt: Date.now(),
          };
          const cliProvider = params.providerUsed ?? entry.modelProvider;
          if (params.cliSessionId && cliProvider) {
            const nextEntry = { ...entry, ...patch };
            setCliSessionId(nextEntry, cliProvider, params.cliSessionId);
            return {
              ...patch,
              cliSessionIds: nextEntry.cliSessionIds,
              claudeCliSessionId: nextEntry.claudeCliSessionId,
            };
          }
          return patch;
        },
      });
    } catch (err) {
      logVerbose(`failed to persist ${label}model/context update: ${String(err)}`);
    }
  }
}
