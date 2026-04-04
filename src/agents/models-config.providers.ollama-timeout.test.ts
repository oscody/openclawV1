import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { debugMock, warnMock } = vi.hoisted(() => ({
  debugMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => {
  const makeLogger = () => ({
    subsystem: "agents/model-providers",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: debugMock,
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => makeLogger(),
  });
  return { createSubsystemLogger: () => makeLogger() };
});

import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Ollama provider timeout handling", () => {
  beforeEach(() => {
    debugMock.mockClear();
    warnMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("does not warn when local ollama discovery times out", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const originalVitest = process.env.VITEST;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalOllamaApiKey = process.env.OLLAMA_API_KEY;

    process.env.OLLAMA_API_KEY = "test-key";
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    const timeoutError = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    const fetchMock = vi.fn().mockRejectedValue(timeoutError);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const providers = await resolveImplicitProviders({ agentDir });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(providers?.ollama?.models).toEqual([]);
      expect(warnMock).not.toHaveBeenCalled();
      expect(debugMock).toHaveBeenCalledWith(
        "Skipped Ollama model discovery after timeout",
        expect.objectContaining({
          baseUrl: "http://127.0.0.1:11434",
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalOllamaApiKey === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = originalOllamaApiKey;
      }
    }
  });
});
