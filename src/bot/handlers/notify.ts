import { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentProject, setCurrentProject } from "../../settings/manager.js";
import { setCurrentSession, getCurrentSession, SessionInfo } from "../../session/manager.js";
import { getCachedSessionProjects } from "../../session/cache-manager.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { keyboardManager } from "../../keyboard/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";

const NOTIFY_SWITCH_PREFIX = "notify:switch:";
const NOTIFY_HISTORY_PREFIX = "notify:history:";

// Format: notify:switch:<projectId>:<sessionId>
function buildNotifySwitchCallback(projectId: string, sessionId: string): string {
  return `${NOTIFY_SWITCH_PREFIX}${projectId}:${sessionId}`;
}

// Format: notify:history:<projectId>:<sessionId>
function buildNotifyHistoryCallback(projectId: string, sessionId: string): string {
  return `${NOTIFY_HISTORY_PREFIX}${projectId}:${sessionId}`;
}

function parseNotifyCallback(
  data: string,
): { type: "switch" | "history"; projectId: string; sessionId: string } | null {
  if (data.startsWith(NOTIFY_SWITCH_PREFIX)) {
    const parts = data.slice(NOTIFY_SWITCH_PREFIX.length).split(":");
    if (parts.length >= 2) {
      return { type: "switch", projectId: parts[0], sessionId: parts.slice(1).join(":") };
    }
  }

  if (data.startsWith(NOTIFY_HISTORY_PREFIX)) {
    const parts = data.slice(NOTIFY_HISTORY_PREFIX.length).split(":");
    if (parts.length >= 2) {
      return { type: "history", projectId: parts[0], sessionId: parts.slice(1).join(":") };
    }
  }

  return null;
}

/**
 * Send a notification for a non-current session event.
 */
export async function sendSessionNotification(
  api: Context["api"],
  chatId: number,
  sessionId: string,
  directory: string,
  eventType: "idle" | "error",
  errorMessage?: string,
): Promise<void> {
  try {
    const baseParams: { sessionID: string; directory?: string } = { sessionID: sessionId };
    if (directory) {
      baseParams.directory = directory;
    }

    const { data: session, error } = await opencodeClient.session.get(baseParams);

    if (error || !session) {
      logger.warn(`[Notify] Failed to fetch session ${sessionId} for notification:`, error);
      return;
    }

    const resolvedDirectory = session.directory || directory;
    if (!resolvedDirectory) {
      logger.warn(
        `[Notify] Session ${sessionId} has no directory in event payload or session data`,
      );
      return;
    }

    const currentSession = getCurrentSession();

    // Don't send notification with buttons if this is the current session
    const isCurrentSession = currentSession?.id === sessionId;

    // Get project name
    const projects = await getCachedSessionProjects();
    const project = projects.find((p) => p.worktree === resolvedDirectory);
    const projectName =
      project?.name || resolvedDirectory.split("/").filter(Boolean).pop() || resolvedDirectory;

    let text: string;
    const keyboard = new InlineKeyboard();

    if (eventType === "idle") {
      text = t("notify.session_idle", { title: session.title });
      if (projectName !== resolvedDirectory) {
        text += "\n" + t("notify.session_idle.directory", { project: projectName });
      }
    } else {
      const msg = errorMessage || t("common.unknown_error");
      text = t("notify.session_error", { title: session.title, message: msg });
      if (projectName !== resolvedDirectory) {
        text += "\n" + t("notify.session_error.directory", { project: projectName });
      }
    }

    // Only add buttons for non-current sessions
    if (!isCurrentSession && project) {
      keyboard.text(t("notify.button.switch"), buildNotifySwitchCallback(project.id, sessionId));
      keyboard.text(t("notify.button.history"), buildNotifyHistoryCallback(project.id, sessionId));
    }

    await api.sendMessage(chatId, text, {
      reply_markup: keyboard,
      disable_notification: false,
    });
  } catch (err) {
    logger.error("[Notify] Failed to send session notification:", err);
  }
}

/**
 * Handle notification callback (switch or view history).
 */
export async function handleNotifyCallback(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data) {
    return false;
  }

  const parsed = parseNotifyCallback(callbackQuery.data);
  if (!parsed) {
    return false;
  }

  try {
    // Find the project/directory from cached projects
    const projects = await getCachedSessionProjects();
    const project = projects.find((p) => p.id === parsed.projectId);

    if (!project) {
      await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
      return true;
    }

    const directory = project.worktree;

    if (parsed.type === "history") {
      // Just show history preview
      await ctx.answerCallbackQuery();

      const { data: session, error } = await opencodeClient.session.get({
        sessionID: parsed.sessionId,
        directory,
      });

      if (error || !session) {
        await ctx.reply(t("sessions.select_error"));
        return true;
      }

      // Load and send preview
      const previewItems = await loadSessionPreview(parsed.sessionId, directory);
      const previewText = formatSessionPreview(session.title, previewItems);
      await ctx.reply(previewText);

      return true;
    }

    if (parsed.type === "switch") {
      // Switch to this session
      const { data: session, error } = await opencodeClient.session.get({
        sessionID: parsed.sessionId,
        directory,
      });

      if (error || !session) {
        await ctx.answerCallbackQuery({ text: t("sessions.select_error") });
        return true;
      }

      // Set project first
      setCurrentProject({ id: project.id, worktree: project.worktree, name: project.name });

      // Set session
      const sessionInfo: SessionInfo = {
        id: session.id,
        title: session.title,
        directory,
      };
      setCurrentSession(sessionInfo);
      summaryAggregator.clear();
      clearAllInteractionState("notify_session_switch");

      await ctx.answerCallbackQuery();

      // Initialize managers
      if (ctx.chat) {
        if (!pinnedMessageManager.isInitialized()) {
          pinnedMessageManager.initialize(ctx.api, ctx.chat.id);
        }
        keyboardManager.initialize(ctx.api, ctx.chat.id);

        try {
          await pinnedMessageManager.onSessionChange(session.id, session.title);
          await pinnedMessageManager.loadContextFromHistory(session.id, directory);
        } catch (err) {
          logger.error("[Notify] Error initializing pinned message:", err);
        }

        const keyboard = keyboardManager.getKeyboard();
        await ctx.reply(
          t("sessions.selected_with_id_html", { title: session.title, id: session.id }),
          {
            reply_markup: keyboard,
            parse_mode: "HTML",
          },
        );
      }

      return true;
    }
  } catch (err) {
    logger.error("[Notify] Error handling notification callback:", err);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
  }

  return true;
}

// Helper functions for session preview (copied from sessions.ts)
type SessionPreviewItem = {
  role: "user" | "assistant";
  text: string;
  created: number;
};

const PREVIEW_MESSAGES_LIMIT = 6;
const PREVIEW_ITEM_MAX_LENGTH = 420;
const TELEGRAM_MESSAGE_LIMIT = 4096;

function extractTextParts(parts: Array<{ type: string; text?: string }>): string | null {
  const textParts = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);

  if (textParts.length === 0) {
    return null;
  }

  const text = textParts.join("").trim();
  return text.length > 0 ? text : null;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const clipped = text.slice(0, Math.max(0, maxLength - 3)).trimEnd();
  return `${clipped}...`;
}

async function loadSessionPreview(
  sessionId: string,
  directory: string,
): Promise<SessionPreviewItem[]> {
  try {
    const { data: messages, error } = await opencodeClient.session.messages({
      sessionID: sessionId,
      directory,
      limit: PREVIEW_MESSAGES_LIMIT,
    });

    if (error || !messages) {
      return [];
    }

    const items = messages
      .map(({ info, parts }) => {
        const role = info.role as "user" | "assistant" | undefined;
        if (role !== "user" && role !== "assistant") {
          return null;
        }

        if (role === "assistant" && (info as { summary?: boolean }).summary) {
          return null;
        }

        const text = extractTextParts(parts as Array<{ type: string; text?: string }>);
        if (!text) {
          return null;
        }

        const created = info.time?.created ?? 0;
        return {
          role,
          text: truncateText(text, PREVIEW_ITEM_MAX_LENGTH),
          created,
        } as SessionPreviewItem;
      })
      .filter((item): item is SessionPreviewItem => Boolean(item));

    return items.sort((a, b) => a.created - b.created);
  } catch {
    return [];
  }
}

function formatSessionPreview(_sessionTitle: string, items: SessionPreviewItem[]): string {
  const lines: string[] = [];

  if (items.length === 0) {
    lines.push(t("sessions.preview.empty"));
    return lines.join("\n");
  }

  lines.push(t("sessions.preview.title"));

  items.forEach((item, index) => {
    const label = item.role === "user" ? t("sessions.preview.you") : t("sessions.preview.agent");
    lines.push(`${label} ${item.text}`);
    if (index < items.length - 1) {
      lines.push("");
    }
  });

  const rawMessage = lines.join("\n");
  return truncateText(rawMessage, TELEGRAM_MESSAGE_LIMIT);
}
