import { setCliSessionId } from "../../agents/cli-session.js";
import { hasNonzeroUsage, type NormalizedUsage } from "../../agents/usage.js";
import {
  type SessionSystemPromptReport,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { appendAiApiCallLog } from "../../infra/ai-call-tracker.js";

export async function persistSessionUsageUpdate(params: {
  storePath?: string;
  sessionKey?: string;
  usage?: NormalizedUsage;
  modelUsed?: string;
  providerUsed?: string;
  contextTokensUsed?: number;
  systemPromptReport?: SessionSystemPromptReport;
  cliSessionId?: string;
  logLabel?: string;
  taskType?: string;
  description?: string;
  source?: string;
}): Promise<void> {
  const { storePath, sessionKey } = params;

  const label = params.logLabel ? `${params.logLabel} ` : "";
  if (hasNonzeroUsage(params.usage)) {
    try {
      const input = params.usage?.input ?? 0;
      const output = params.usage?.output ?? 0;
      const total = params.usage?.total ?? input + output;
      await appendAiApiCallLog({
        model: params.modelUsed,
        usage: {
          input,
          output,
          total,
        },
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
            const input = params.usage?.input ?? 0;
            const output = params.usage?.output ?? 0;
            const promptTokens =
              input + (params.usage?.cacheRead ?? 0) + (params.usage?.cacheWrite ?? 0);
            const patch: Partial<SessionEntry> = {
              inputTokens: input,
              outputTokens: output,
              totalTokens: promptTokens > 0 ? promptTokens : (params.usage?.total ?? input),
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
