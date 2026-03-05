import type { ModelInfo } from "../model/types.js";

export interface KeyboardState {
  currentAgent: string;
  currentModel: ModelInfo;
  variantName?: string;
}
