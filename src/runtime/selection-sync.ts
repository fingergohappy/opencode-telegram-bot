import type { ModelInfo } from "../model/types.js";
import { getCurrentProject, setCurrentAgent, setCurrentModel } from "../settings/manager.js";
import { getCurrentSession } from "../session/manager.js";
import { config } from "../config.js";
import { opencodeClient } from "../opencode/client.js";
import { logger } from "../utils/logger.js";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getStringFromPaths(source: unknown, paths: string[]): string | null {
  if (!isRecord(source)) {
    return null;
  }

  for (const path of paths) {
    const segments = path.split(".");
    let current: unknown = source;

    for (const segment of segments) {
      if (!isRecord(current) || !(segment in current)) {
        current = null;
        break;
      }

      current = current[segment];
    }

    if (typeof current === "string" && current.trim().length > 0) {
      return current.trim();
    }
  }

  return null;
}

function parseModelString(model: string): { providerID: string; modelID: string } | null {
  const separatorIndex = model.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= model.length - 1) {
    return null;
  }

  const providerID = model.slice(0, separatorIndex).trim();
  const modelID = model.slice(separatorIndex + 1).trim();
  if (!providerID || !modelID) {
    return null;
  }

  return { providerID, modelID };
}

function resolveProviderFromConfig(payload: unknown, modelID: string): string | null {
  if (!isRecord(payload) || !isRecord(payload.provider)) {
    return null;
  }

  const providers = payload.provider;
  for (const [providerID, providerConfig] of Object.entries(providers)) {
    if (!isRecord(providerConfig) || !isRecord(providerConfig.models)) {
      continue;
    }

    if (modelID in providerConfig.models) {
      return providerID;
    }
  }

  return null;
}

export function extractAgentFromConfigPayload(payload: unknown): string | null {
  return getStringFromPaths(payload, ["default_agent", "mode"]);
}

export function extractModelFromConfigPayload(payload: unknown): ModelInfo | null {
  const variant = getStringFromPaths(payload, ["variant"]) || "default";
  const model = getStringFromPaths(payload, ["model"]);

  if (!model) {
    return null;
  }

  const parsed = parseModelString(model);
  if (parsed) {
    return {
      providerID: parsed.providerID,
      modelID: parsed.modelID,
      variant,
    };
  }

  const providerID = resolveProviderFromConfig(payload, model);
  if (!providerID) {
    return null;
  }

  return {
    providerID,
    modelID: model,
    variant,
  };
}

async function fetchConfigPayload(directory: string): Promise<unknown | null> {
  try {
    const headers: Record<string, string> = {
      "x-opencode-directory": directory,
    };

    if (config.opencode.password) {
      const credentials = `${config.opencode.username}:${config.opencode.password}`;
      headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }

    const response = await fetch(`${config.opencode.apiUrl.replace(/\/$/, "")}/config`, {
      headers,
    });

    if (!response.ok) {
      logger.debug(`[SelectionSync] /config request failed with status ${response.status}`);
      return null;
    }

    return (await response.json()) as unknown;
  } catch (err) {
    logger.debug("[SelectionSync] Failed to fetch /config payload", err);
    return null;
  }
}

export function extractAgentFromSessionPayload(payload: unknown): string | null {
  return getStringFromPaths(payload, ["agent", "mode", "info.agent", "info.mode", "config.agent"]);
}

export function extractModelFromSessionPayload(payload: unknown): ModelInfo | null {
  const providerID = getStringFromPaths(payload, [
    "providerID",
    "providerId",
    "model.providerID",
    "model.providerId",
    "info.model.providerID",
    "info.model.providerId",
    "config.model.providerID",
    "config.model.providerId",
  ]);
  const modelID = getStringFromPaths(payload, [
    "modelID",
    "modelId",
    "model.modelID",
    "model.modelId",
    "info.model.modelID",
    "info.model.modelId",
    "config.model.modelID",
    "config.model.modelId",
  ]);
  const variant =
    getStringFromPaths(payload, [
      "model.variant",
      "info.model.variant",
      "config.model.variant",
      "variant",
      "info.variant",
      "config.variant",
    ]) || "default";

  if (providerID && modelID) {
    return { providerID, modelID, variant };
  }

  const modelString = getStringFromPaths(payload, ["model", "info.model", "config.model"]);
  if (!modelString) {
    return null;
  }

  const parsed = parseModelString(modelString);
  if (!parsed) {
    return null;
  }

  return {
    providerID: parsed.providerID,
    modelID: parsed.modelID,
    variant,
  };
}

export async function syncStoredSelectionFromActiveSession(): Promise<void> {
  const currentProject = getCurrentProject();
  const currentSession = getCurrentSession();
  const directory = currentProject?.worktree || currentSession?.directory;

  if (!directory) {
    return;
  }

  try {
    const configPayload = await fetchConfigPayload(directory);
    let runtimeAgent = extractAgentFromConfigPayload(configPayload);
    let runtimeModel = extractModelFromConfigPayload(configPayload);

    if ((!runtimeAgent || !runtimeModel) && currentSession) {
      const { data: messages, error: messagesError } = await opencodeClient.session.messages({
        sessionID: currentSession.id,
        directory,
        limit: 1,
      });

      if (messagesError) {
        logger.debug("[SelectionSync] Failed to fetch session messages for sync", messagesError);
      } else {
        const lastMessageInfo = messages?.[0]?.info;
        if (!runtimeAgent) {
          runtimeAgent = extractAgentFromSessionPayload(lastMessageInfo);
        }
        if (!runtimeModel) {
          runtimeModel = extractModelFromSessionPayload(lastMessageInfo);
        }
      }
    }

    if (runtimeAgent) {
      setCurrentAgent(runtimeAgent);
    }

    if (runtimeModel) {
      setCurrentModel(runtimeModel);
    }

    logger.debug(
      `[SelectionSync] Synced from config/session: directory=${directory}, session=${currentSession?.id || "n/a"}, agent=${runtimeAgent || "n/a"}, model=${runtimeModel ? `${runtimeModel.providerID}/${runtimeModel.modelID}` : "n/a"}, variant=${runtimeModel?.variant || "n/a"}`,
    );
  } catch (err) {
    logger.debug("[SelectionSync] Failed to sync selection from active session", err);
  }
}
