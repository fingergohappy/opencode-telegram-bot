import { Keyboard } from "grammy";
import { getAgentDisplayName } from "../../agent/types.js";
import { formatModelForButton } from "../../model/types.js";
import type { ModelInfo } from "../../model/types.js";
import { t } from "../../i18n/index.js";

export function createMainKeyboard(
  currentAgent: string,
  currentModel: ModelInfo,
  variantName?: string,
): Keyboard {
  const keyboard = new Keyboard();
  const agentText = getAgentDisplayName(currentAgent);
  const modelText = formatModelForButton(currentModel.providerID, currentModel.modelID);
  const variantText = variantName || t("keyboard.variant_default");

  keyboard.text(agentText).text(modelText).text(variantText).row();

  return keyboard.resized().persistent();
}

export function createAgentKeyboard(currentAgent: string): Keyboard {
  const keyboard = new Keyboard();
  const displayName = getAgentDisplayName(currentAgent);
  keyboard.text(displayName).row();
  return keyboard.resized().persistent();
}

export function removeKeyboard(): { remove_keyboard: true } {
  return { remove_keyboard: true };
}
