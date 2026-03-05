import { getCurrentModel, setCurrentModel } from "../settings/manager.js";
import { config } from "../config.js";
import { opencodeClient } from "../opencode/client.js";
import { logger } from "../utils/logger.js";
import type { ModelInfo, FavoriteModel, ModelSelectionLists } from "./types.js";
import path from "node:path";

interface OpenCodeModelState {
  favorite?: Array<{ providerID?: string; modelID?: string }>;
  recent?: Array<{ providerID?: string; modelID?: string }>;
}

let serverDefaultModel: FavoriteModel | null = null;

export async function initDefaultModelFromServer(): Promise<void> {
  try {
    const { data, error } = await opencodeClient.config.providers();
    if (error || !data) {
      logger.warn("[ModelManager] Failed to fetch providers for default model:", error);
      return;
    }

    const defaults = (data as { default?: Record<string, string> }).default;
    if (defaults && typeof defaults === "object") {
      const entries = Object.entries(defaults);
      if (entries.length > 0) {
        const [providerID, modelID] = entries[0];
        serverDefaultModel = { providerID, modelID };
        logger.info(`[ModelManager] Server default model: ${providerID}/${modelID}`);
        return;
      }
    }

    logger.warn("[ModelManager] No default model found from server");
  } catch (err) {
    logger.error("[ModelManager] Error fetching default model from server:", err);
  }
}

function getDefaultModel(): FavoriteModel | null {
  if (config.opencode.model.provider && config.opencode.model.modelId) {
    return {
      providerID: config.opencode.model.provider,
      modelID: config.opencode.model.modelId,
    };
  }

  return serverDefaultModel;
}

function dedupeModels(models: FavoriteModel[]): FavoriteModel[] {
  const unique = new Map<string, FavoriteModel>();

  for (const model of models) {
    const key = `${model.providerID}/${model.modelID}`;
    if (!unique.has(key)) {
      unique.set(key, model);
    }
  }

  return Array.from(unique.values());
}

function normalizeFavoriteModels(state: OpenCodeModelState): FavoriteModel[] {
  if (!Array.isArray(state.favorite)) {
    return [];
  }

  return state.favorite
    .filter(
      (model): model is { providerID: string; modelID: string } =>
        typeof model?.providerID === "string" &&
        model.providerID.length > 0 &&
        typeof model.modelID === "string" &&
        model.modelID.length > 0,
    )
    .map((model) => ({
      providerID: model.providerID,
      modelID: model.modelID,
    }));
}

function normalizeRecentModels(state: OpenCodeModelState): FavoriteModel[] {
  if (!Array.isArray(state.recent)) {
    return [];
  }

  return state.recent
    .filter(
      (model): model is { providerID: string; modelID: string } =>
        typeof model?.providerID === "string" &&
        model.providerID.length > 0 &&
        typeof model.modelID === "string" &&
        model.modelID.length > 0,
    )
    .map((model) => ({
      providerID: model.providerID,
      modelID: model.modelID,
    }));
}

function getOpenCodeModelStatePath(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;

  if (xdgStateHome && xdgStateHome.trim().length > 0) {
    return path.join(xdgStateHome, "opencode", "model.json");
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(homeDir, ".local", "state", "opencode", "model.json");
}

/**
 * Get favorite and recent models from OpenCode local state file.
 * Config model is always treated as favorite.
 */
export async function getModelSelectionLists(): Promise<ModelSelectionLists> {
  const defaultModel = getDefaultModel();

  try {
    const fs = await import("fs/promises");

    const stateFilePath = getOpenCodeModelStatePath();
    const content = await fs.readFile(stateFilePath, "utf-8");
    const state = JSON.parse(content) as OpenCodeModelState;

    const rawFavorites = normalizeFavoriteModels(state);
    const favorites = defaultModel ? dedupeModels([...rawFavorites, defaultModel]) : rawFavorites;

    if (rawFavorites.length === 0 && defaultModel) {
      logger.info(
        `[ModelManager] No favorites in ${stateFilePath}, using config model as favorite`,
      );
    }

    if (favorites.length === 0) {
      logger.warn(`[ModelManager] No favorites in ${stateFilePath}`);
    }

    const favoriteKeys = new Set(favorites.map((model) => `${model.providerID}/${model.modelID}`));
    const recent = dedupeModels(normalizeRecentModels(state)).filter(
      (model) => !favoriteKeys.has(`${model.providerID}/${model.modelID}`),
    );

    logger.debug(
      `[ModelManager] Loaded model selection lists from ${stateFilePath}: favorites=${favorites.length}, recent=${recent.length}`,
    );

    return { favorites, recent };
  } catch (err) {
    if (defaultModel) {
      logger.warn(
        "[ModelManager] Failed to load OpenCode model state, using default model as favorite:",
        err,
      );
      return {
        favorites: [defaultModel],
        recent: [],
      };
    }

    logger.error("[ModelManager] Failed to load OpenCode model state:", err);
    return {
      favorites: [],
      recent: [],
    };
  }
}

/**
 * Get list of favorite models from OpenCode local state file
 * Falls back to env default model if file is unavailable or empty
 */
export async function getFavoriteModels(): Promise<FavoriteModel[]> {
  const { favorites } = await getModelSelectionLists();
  return favorites;
}

/**
 * Get current model from settings or fallback to config
 * @returns Current model info
 */
export function fetchCurrentModel(): ModelInfo {
  return getStoredModel();
}

/**
 * Select model and persist to settings
 * @param modelInfo Model to select
 */
export function selectModel(modelInfo: ModelInfo): void {
  logger.info(`[ModelManager] Selected model: ${modelInfo.providerID}/${modelInfo.modelID}`);
  setCurrentModel(modelInfo);
}

/**
 * Get stored model from settings (synchronous)
 * ALWAYS returns a model - fallback to config if not found
 * @returns Current model info
 */
export function getStoredModel(): ModelInfo {
  const storedModel = getCurrentModel();

  if (storedModel) {
    if (!storedModel.variant) {
      storedModel.variant = "default";
    }
    return storedModel;
  }

  const defaultModel = getDefaultModel();
  if (defaultModel) {
    logger.debug(
      `[ModelManager] Using default model: ${defaultModel.providerID}/${defaultModel.modelID}`,
    );
    return {
      providerID: defaultModel.providerID,
      modelID: defaultModel.modelID,
      variant: "default",
    };
  }

  logger.warn(
    "[ModelManager] No model found in settings or server defaults, returning empty model",
  );
  return {
    providerID: "",
    modelID: "",
    variant: "default",
  };
}
