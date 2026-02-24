import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistSessionUsageUpdate } from "./session-usage.js";

vi.mock("../../infra/ai-call-tracker.js", () => ({
  appendAiApiCallLog: vi.fn(),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStoreEntry: vi.fn(),
}));

import { updateSessionStoreEntry } from "../../config/sessions.js";
import { appendAiApiCallLog } from "../../infra/ai-call-tracker.js";

describe("persistSessionUsageUpdate", () => {
  beforeEach(() => {
    vi.mocked(appendAiApiCallLog).mockReset();
    vi.mocked(updateSessionStoreEntry).mockReset();
  });

  it("appends ai-call log even when storePath/sessionKey are missing", async () => {
    await persistSessionUsageUpdate({
      usage: { input: 10, output: 2, total: 12 },
      modelUsed: "openai-codex/gpt-5.2",
      taskType: "verification",
      description: "usage log without session store",
      source: "session-usage-test",
    });

    expect(appendAiApiCallLog).toHaveBeenCalledTimes(1);
    expect(updateSessionStoreEntry).not.toHaveBeenCalled();
  });

  it("updates both tracker log and session store when storePath/sessionKey are present", async () => {
    await persistSessionUsageUpdate({
      storePath: "/tmp/session-store.json",
      sessionKey: "agent:test:main",
      usage: { input: 20, output: 5, total: 25 },
      modelUsed: "openai-codex/gpt-5.2",
      providerUsed: "openai-codex",
      taskType: "verification",
      description: "usage log with session store",
      source: "session-usage-test",
    });

    expect(appendAiApiCallLog).toHaveBeenCalledTimes(1);
    expect(updateSessionStoreEntry).toHaveBeenCalledTimes(1);
  });
});
