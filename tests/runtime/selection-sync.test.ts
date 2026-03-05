import { describe, expect, it } from "vitest";

import {
  extractAgentFromConfigPayload,
  extractAgentFromSessionPayload,
  extractModelFromConfigPayload,
  extractModelFromSessionPayload,
} from "../../src/runtime/selection-sync.js";

describe("runtime/selection-sync", () => {
  describe("extractAgentFromSessionPayload", () => {
    it("extracts agent from top-level field", () => {
      expect(extractAgentFromSessionPayload({ agent: "sisyphus" })).toBe("sisyphus");
    });

    it("extracts agent from nested info field", () => {
      expect(extractAgentFromSessionPayload({ info: { agent: "build" } })).toBe("build");
    });

    it("extracts agent from mode field", () => {
      expect(extractAgentFromSessionPayload({ mode: "sisyphus" })).toBe("sisyphus");
      expect(extractAgentFromSessionPayload({ info: { mode: "sisyphus" } })).toBe("sisyphus");
    });

    it("returns null when no usable agent exists", () => {
      expect(extractAgentFromSessionPayload({ info: { agent: "" } })).toBeNull();
      expect(extractAgentFromSessionPayload(null)).toBeNull();
    });
  });

  describe("extractModelFromSessionPayload", () => {
    it("extracts provider/model from flat info shape", () => {
      expect(
        extractModelFromSessionPayload({
          providerID: "cli-proxy-api",
          modelID: "gpt-5.3-codex",
        }),
      ).toEqual({
        providerID: "cli-proxy-api",
        modelID: "gpt-5.3-codex",
        variant: "default",
      });
    });

    it("extracts provider/model/variant from nested object", () => {
      expect(
        extractModelFromSessionPayload({
          model: {
            providerID: "cliproxyapi2",
            modelID: "gpt-5.3-codex",
            variant: "default",
          },
        }),
      ).toEqual({
        providerID: "cliproxyapi2",
        modelID: "gpt-5.3-codex",
        variant: "default",
      });
    });

    it("parses compact model string and uses default variant", () => {
      expect(
        extractModelFromSessionPayload({
          model: "cliproxyapi2/gpt-5.3-codex",
        }),
      ).toEqual({
        providerID: "cliproxyapi2",
        modelID: "gpt-5.3-codex",
        variant: "default",
      });
    });

    it("uses top-level variant when present", () => {
      expect(
        extractModelFromSessionPayload({
          model: "cliproxyapi2/gpt-5.3-codex",
          variant: "fast",
        }),
      ).toEqual({
        providerID: "cliproxyapi2",
        modelID: "gpt-5.3-codex",
        variant: "fast",
      });
    });

    it("returns null when model cannot be resolved", () => {
      expect(extractModelFromSessionPayload({ model: "invalid-format" })).toBeNull();
      expect(extractModelFromSessionPayload({})).toBeNull();
    });
  });

  describe("extractAgentFromConfigPayload", () => {
    it("extracts default agent from /config payload", () => {
      expect(extractAgentFromConfigPayload({ default_agent: "sisyphus" })).toBe("sisyphus");
    });

    it("returns null when default agent is missing", () => {
      expect(extractAgentFromConfigPayload({})).toBeNull();
    });
  });

  describe("extractModelFromConfigPayload", () => {
    it("resolves model by provider lookup when model is bare id", () => {
      expect(
        extractModelFromConfigPayload({
          model: "gpt-5.3-codex",
          provider: {
            "cli-proxy-api": {
              models: {
                "gpt-5.3-codex": { name: "gpt-5.3-codex" },
              },
            },
          },
        }),
      ).toEqual({
        providerID: "cli-proxy-api",
        modelID: "gpt-5.3-codex",
        variant: "default",
      });
    });

    it("uses explicit provider/model format when available", () => {
      expect(
        extractModelFromConfigPayload({
          model: "cli-proxy-api/gpt-5.3-codex",
          variant: "high",
        }),
      ).toEqual({
        providerID: "cli-proxy-api",
        modelID: "gpt-5.3-codex",
        variant: "high",
      });
    });

    it("returns null when provider cannot be resolved", () => {
      expect(
        extractModelFromConfigPayload({
          model: "gpt-5.3-codex",
          provider: {
            openai: {
              models: {
                "gpt-4o": { name: "gpt-4o" },
              },
            },
          },
        }),
      ).toBeNull();
    });
  });
});
