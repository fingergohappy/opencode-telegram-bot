import { Context } from "grammy";
import { createMainKeyboard } from "../utils/keyboard.js";
import { getStoredAgent } from "../../agent/manager.js";
import { getStoredModel } from "../../model/manager.js";
import { formatVariantForButton } from "../../variant/manager.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { keyboardManager } from "../../keyboard/manager.js";
import { syncStoredSelectionFromActiveSession } from "../../runtime/selection-sync.js";
import { t } from "../../i18n/index.js";

export async function startCommand(ctx: Context): Promise<void> {
  await syncStoredSelectionFromActiveSession();

  if (ctx.chat) {
    if (!pinnedMessageManager.isInitialized()) {
      pinnedMessageManager.initialize(ctx.api, ctx.chat.id);
    }
    keyboardManager.initialize(ctx.api, ctx.chat.id);
  }

  const currentAgent = getStoredAgent();
  const currentModel = getStoredModel();
  const variantName = formatVariantForButton(currentModel.variant || "default");

  keyboardManager.updateAgent(currentAgent);
  keyboardManager.updateModel(currentModel);

  const keyboard = createMainKeyboard(currentAgent, currentModel, variantName);

  await ctx.reply(t("start.welcome"), { reply_markup: keyboard });
}
