import { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { setCurrentSession, clearSession, SessionInfo } from "../../session/manager.js";
import { getCurrentProject, setCurrentProject } from "../../settings/manager.js";
import { getProjects } from "../../project/manager.js";
import { syncSessionDirectoryCache } from "../../session/cache-manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { keyboardManager } from "../../keyboard/manager.js";
import {
  appendInlineMenuCancelButton,
  ensureActiveInlineMenu,
  replyWithInlineMenu,
} from "../handlers/inline-menu.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { config } from "../../config.js";
import { getDateLocale, t } from "../../i18n/index.js";

const SESSION_CALLBACK_PREFIX = "session:";
const SESSION_PAGE_CALLBACK_PREFIX = "session:page:";
const SESSION_FETCH_EXTRA_COUNT = 1;

type SessionListItem = {
  id: string;
  title: string;
  directory: string;
  time: {
    created: number;
  };
};

type SessionPage = {
  sessions: SessionListItem[];
  hasNext: boolean;
  page: number;
};

function buildSessionPageCallback(page: number): string {
  return `${SESSION_PAGE_CALLBACK_PREFIX}${page}`;
}

function parseSessionPageCallback(data: string): number | null {
  if (!data.startsWith(SESSION_PAGE_CALLBACK_PREFIX)) {
    return null;
  }

  const rawPage = data.slice(SESSION_PAGE_CALLBACK_PREFIX.length);
  const page = Number(rawPage);
  if (!Number.isInteger(page) || page < 0) {
    return null;
  }

  return page;
}

function parseSessionIdCallback(data: string): string | null {
  if (!data.startsWith(SESSION_CALLBACK_PREFIX)) {
    return null;
  }

  if (data.startsWith(SESSION_PAGE_CALLBACK_PREFIX)) {
    return null;
  }

  const sessionId = data.slice(SESSION_CALLBACK_PREFIX.length);
  return sessionId.length > 0 ? sessionId : null;
}

function formatSessionsSelectText(page: number): string {
  if (page === 0) {
    return t("sessions.select");
  }

  return t("sessions.select_page", { page: page + 1 });
}

async function loadSessionPage(
  directory: string,
  page: number,
  pageSize: number,
): Promise<SessionPage> {
  const startIndex = page * pageSize;
  const endExclusive = startIndex + pageSize;

  const { data: sessions, error } = await opencodeClient.session.list({
    directory,
    limit: endExclusive + SESSION_FETCH_EXTRA_COUNT,
  });

  if (error || !sessions) {
    throw error || new Error("No data received from server");
  }

  const hasNext = sessions.length > endExclusive;
  const pagedSessions = sessions.slice(startIndex, endExclusive);

  logger.debug(
    `[Sessions] Loaded page=${page + 1}, startIndex=${startIndex}, endExclusive=${endExclusive}, pageSize=${pageSize}, items=${pagedSessions.length}, hasNext=${hasNext}`,
  );

  return {
    sessions: pagedSessions as SessionListItem[],
    hasNext,
    page,
  };
}

function buildSessionsKeyboard(pageData: SessionPage, pageSize: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const localeForDate = getDateLocale();
  const pageStartIndex = pageData.page * pageSize;

  pageData.sessions.forEach((session, index) => {
    const date = new Date(session.time.created).toLocaleDateString(localeForDate);
    const label = `${pageStartIndex + index + 1}. ${session.title} (${date})`;
    keyboard.text(label, `${SESSION_CALLBACK_PREFIX}${session.id}`).row();
  });

  if (pageData.page > 0) {
    keyboard.text(t("sessions.button.prev_page"), buildSessionPageCallback(pageData.page - 1));
  }

  if (pageData.hasNext) {
    keyboard.text(t("sessions.button.next_page"), buildSessionPageCallback(pageData.page + 1));
  }

  if (pageData.page > 0 || pageData.hasNext) {
    keyboard.row();
  }

  return keyboard;
}

type ProjectListItem = {
  id: string;
  worktree: string;
  name?: string;
};

const SESSIONS_PROJECT_CALLBACK_PREFIX = "sessions:project:";
const SESSIONS_PROJECT_PAGE_CALLBACK_PREFIX = "sessions:project:page:";
const SESSIONS_BACK_TO_PROJECTS_CALLBACK = "sessions:project:back";

function buildSessionsProjectCallback(projectId: string): string {
  return `${SESSIONS_PROJECT_CALLBACK_PREFIX}${projectId}`;
}

function parseSessionsProjectCallback(data: string): string | null {
  if (!data.startsWith(SESSIONS_PROJECT_CALLBACK_PREFIX)) {
    return null;
  }

  if (data.startsWith(SESSIONS_PROJECT_PAGE_CALLBACK_PREFIX)) {
    return null;
  }

  if (data === SESSIONS_BACK_TO_PROJECTS_CALLBACK) {
    return null;
  }

  const projectId = data.slice(SESSIONS_PROJECT_CALLBACK_PREFIX.length);
  return projectId.length > 0 ? projectId : null;
}

function buildSessionsProjectPageCallback(page: number): string {
  return `${SESSIONS_PROJECT_PAGE_CALLBACK_PREFIX}${page}`;
}

function parseSessionsProjectPageCallback(data: string): number | null {
  if (!data.startsWith(SESSIONS_PROJECT_PAGE_CALLBACK_PREFIX)) {
    return null;
  }

  const rawPage = data.slice(SESSIONS_PROJECT_PAGE_CALLBACK_PREFIX.length);
  const page = Number(rawPage);
  if (!Number.isInteger(page) || page < 0) {
    return null;
  }

  return page;
}

function formatSessionsSelectProjectText(): string {
  return t("sessions.select_project");
}

function formatProjectLabel(index: number, project: ProjectListItem, isActive: boolean): string {
  const folderName = project.worktree.replace(/[\\/]+$/g, "").split(/[\\/]/).filter(Boolean).at(-1) || project.worktree;
  const prefix = isActive ? "✅ " : "";
  const label = `${index + 1}. ${folderName}`;
  const full = `${prefix}${label}`;
  return full.length > 64 ? `${full.slice(0, 61)}...` : full;
}

async function loadProjectsPage(page: number): Promise<{ projects: ProjectListItem[]; hasNext: boolean; page: number }> {
  await syncSessionDirectoryCache();
  const projects = (await getProjects()) as ProjectListItem[];
  const pageSize = config.bot.projectsListLimit;

  const currentProject = getCurrentProject();

  // Stable sort: current project first, then by worktree.
  const sorted = [...projects].sort((a, b) => {
    const aActive = currentProject && (a.id === currentProject.id || a.worktree === currentProject.worktree) ? 0 : 1;
    const bActive = currentProject && (b.id === currentProject.id || b.worktree === currentProject.worktree) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.worktree.localeCompare(b.worktree);
  });

  const startIndex = page * pageSize;
  const endExclusive = startIndex + pageSize;
  const hasNext = sorted.length > endExclusive;

  return {
    projects: sorted.slice(startIndex, endExclusive),
    hasNext,
    page,
  };
}

function buildProjectsKeyboardForSessions(
  pageData: { projects: ProjectListItem[]; hasNext: boolean; page: number },
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const currentProject = getCurrentProject();
  const pageStartIndex = pageData.page * config.bot.projectsListLimit;

  pageData.projects.forEach((project, index) => {
    const isActive =
      !!currentProject && (project.id === currentProject.id || project.worktree === currentProject.worktree);
    const label = formatProjectLabel(pageStartIndex + index, project, isActive);
    keyboard.text(label, buildSessionsProjectCallback(project.id)).row();
  });

  if (pageData.page > 0) {
    keyboard.text(t("sessions.button.prev_page"), buildSessionsProjectPageCallback(pageData.page - 1));
  }

  if (pageData.hasNext) {
    keyboard.text(t("sessions.button.next_page"), buildSessionsProjectPageCallback(pageData.page + 1));
  }

  return keyboard;
}

async function showProjectsMenuForSessions(ctx: Context, page: number): Promise<void> {
  const pageData = await loadProjectsPage(page);
  if (pageData.projects.length === 0) {
    await ctx.reply(t("projects.empty"));
    return;
  }

  const keyboard = buildProjectsKeyboardForSessions(pageData);

  await replyWithInlineMenu(ctx, {
    menuKind: "session",
    text: formatSessionsSelectProjectText(),
    keyboard,
  });
}

export async function sessionsCommand(ctx: CommandContext<Context>) {
  try {
    // Scheme B: Always show project selection first, with current project highlighted.
    await showProjectsMenuForSessions(ctx, 0);
  } catch (error) {
    logger.error("[Sessions] Error opening sessions project menu:", error);
    await ctx.reply(t("sessions.fetch_error"));
  }
}

export async function handleSessionSelect(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data) {
    return false;
  }

  // Sessions menu is now two-level: Project -> Session
  const projectPage = parseSessionsProjectPageCallback(callbackQuery.data);
  const projectId = parseSessionsProjectCallback(callbackQuery.data);
  const backToProjects = callbackQuery.data === SESSIONS_BACK_TO_PROJECTS_CALLBACK;

  if (projectPage !== null || projectId !== null || backToProjects) {
    const isActiveMenu = await ensureActiveInlineMenu(ctx, "session");
    if (!isActiveMenu) {
      return true;
    }

    try {
      if (backToProjects) {
        const pageData = await loadProjectsPage(0);
        const keyboard = buildProjectsKeyboardForSessions(pageData);
        appendInlineMenuCancelButton(keyboard, "session");
        await ctx.editMessageText(formatSessionsSelectProjectText(), {
          reply_markup: keyboard,
        });
        await ctx.answerCallbackQuery();
        return true;
      }

      if (projectPage !== null) {
        const pageData = await loadProjectsPage(projectPage);
        if (pageData.projects.length === 0) {
          await ctx.answerCallbackQuery({ text: t("sessions.page_empty_callback") });
          return true;
        }

        const keyboard = buildProjectsKeyboardForSessions(pageData);
        appendInlineMenuCancelButton(keyboard, "session");
        await ctx.editMessageText(formatSessionsSelectProjectText(), {
          reply_markup: keyboard,
        });
        await ctx.answerCallbackQuery();
        return true;
      }

      if (projectId) {
        const projects = (await getProjects()) as ProjectListItem[];
        const selectedProject = projects.find((p) => p.id === projectId);

        if (!selectedProject) {
          await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
          return true;
        }

        // Switch project context (same behavior as /projects)
        setCurrentProject(selectedProject);
        
        // Clear session state when switching projects to avoid mismatch errors
        clearSession();
        summaryAggregator.clear();

        const pageSize = config.bot.sessionsListLimit;
        const firstPage = await loadSessionPage(selectedProject.worktree, 0, pageSize);

        if (firstPage.sessions.length === 0) {
          await ctx.answerCallbackQuery();
          await ctx.reply(t("sessions.empty"));
          return true;
        }

        const keyboard = buildSessionsKeyboard(firstPage, pageSize);
        keyboard.row();
        keyboard.text(t("sessions.button.back_to_projects"), SESSIONS_BACK_TO_PROJECTS_CALLBACK);
        appendInlineMenuCancelButton(keyboard, "session");

        await ctx.editMessageText(formatSessionsSelectText(firstPage.page), {
          reply_markup: keyboard,
        });
        await ctx.answerCallbackQuery();
        return true;
      }
    } catch (err) {
      logger.error("[Sessions] Error handling sessions project menu callback:", err);
      await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
      return true;
    }
  }

  if (!callbackQuery.data.startsWith(SESSION_CALLBACK_PREFIX)) {
    return false;
  }

  const page = parseSessionPageCallback(callbackQuery.data);
  const sessionId = parseSessionIdCallback(callbackQuery.data);

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "session");
  if (!isActiveMenu) {
    return true;
  }

  try {
    const currentProject = getCurrentProject();

    if (!currentProject) {
      clearAllInteractionState("session_select_project_missing");
      await ctx.answerCallbackQuery();
      await ctx.reply(t("sessions.select_project_first"));
      return true;
    }

    if (page !== null) {
      try {
        const pageSize = config.bot.sessionsListLimit;
        const pageData = await loadSessionPage(currentProject.worktree, page, pageSize);
        if (pageData.sessions.length === 0) {
          await ctx.answerCallbackQuery({ text: t("sessions.page_empty_callback") });
          return true;
        }

        const keyboard = buildSessionsKeyboard(pageData, pageSize);
        keyboard.row();
        keyboard.text(t("sessions.button.back_to_projects"), SESSIONS_BACK_TO_PROJECTS_CALLBACK);
        appendInlineMenuCancelButton(keyboard, "session");
        await ctx.editMessageText(formatSessionsSelectText(pageData.page), {
          reply_markup: keyboard,
        });
        await ctx.answerCallbackQuery();
      } catch (error) {
        logger.error("[Sessions] Error loading sessions page:", error);
        await ctx.answerCallbackQuery({ text: t("sessions.page_load_error_callback") });
      }

      return true;
    }

    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
      return true;
    }

    const { data: session, error } = await opencodeClient.session.get({
      sessionID: sessionId,
      directory: currentProject.worktree,
    });

    if (error || !session) {
      throw error || new Error("Failed to get session details");
    }

    logger.info(
      `[Bot] Session selected: id=${session.id}, title="${session.title}", project=${currentProject.worktree}`,
    );

    const sessionInfo: SessionInfo = {
      id: session.id,
      title: session.title,
      directory: currentProject.worktree,
    };
    setCurrentSession(sessionInfo);
    summaryAggregator.clear();
    clearAllInteractionState("session_switched");

    await ctx.answerCallbackQuery();

    let loadingMessageId: number | null = null;
    if (ctx.chat) {
      try {
        const loadingMessage = await ctx.api.sendMessage(
          ctx.chat.id,
          t("sessions.loading_context"),
        );
        loadingMessageId = loadingMessage.message_id;
      } catch (err) {
        logger.error("[Sessions] Failed to send loading message:", err);
      }
    }

    // Initialize pinned message manager if not already
    if (!pinnedMessageManager.isInitialized() && ctx.chat) {
      pinnedMessageManager.initialize(ctx.api, ctx.chat.id);
    }

    // Initialize keyboard manager if not already
    if (ctx.chat) {
      keyboardManager.initialize(ctx.api, ctx.chat.id);
    }

    try {
      // Create new pinned message for this session
      await pinnedMessageManager.onSessionChange(session.id, session.title);
      // Load context from session history (for existing sessions)
      // Wait for it to complete so keyboard has correct context
      await pinnedMessageManager.loadContextFromHistory(session.id, currentProject.worktree);
    } catch (err) {
      logger.error("[Bot] Error initializing pinned message:", err);
    }

    if (ctx.chat) {
      const chatId = ctx.chat.id;

      // Update keyboard with loaded context (callback executes async via setImmediate, so update manually)
      const contextInfo = pinnedMessageManager.getContextInfo();
      if (contextInfo) {
        keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);
      }

      // Delete loading message
      if (loadingMessageId) {
        try {
          await ctx.api.deleteMessage(chatId, loadingMessageId);
        } catch (err) {
          logger.debug("[Sessions] Failed to delete loading message:", err);
        }
      }

      // Send session selection confirmation with updated keyboard
      const keyboard = keyboardManager.getKeyboard();
      try {
        await ctx.api.sendMessage(chatId, t("sessions.selected", { title: session.title }), {
          reply_markup: keyboard,
        });
      } catch (err) {
        logger.error("[Sessions] Failed to send selection message:", err);
      }

      // Send preview asynchronously
      safeBackgroundTask({
        taskName: "sessions.sendPreview",
        task: () =>
          sendSessionPreview(
            ctx.api,
            chatId,
            null,
            session.title,
            session.id,
            currentProject.worktree,
          ),
      });
    }

    await ctx.deleteMessage();
  } catch (error) {
    clearAllInteractionState("session_select_error");
    logger.error("[Sessions] Error selecting session:", error);
    await ctx.answerCallbackQuery();
    await ctx.reply(t("sessions.select_error"));
  }

  return true;
}

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
      logger.warn("[Sessions] Failed to fetch session messages:", error);
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
  } catch (err) {
    logger.error("[Sessions] Error loading session preview:", err);
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

async function sendSessionPreview(
  api: Context["api"],
  chatId: number,
  messageId: number | null,
  sessionTitle: string,
  sessionId: string,
  directory: string,
): Promise<void> {
  const previewItems = await loadSessionPreview(sessionId, directory);
  const finalText = formatSessionPreview(sessionTitle, previewItems);

  if (messageId) {
    try {
      await api.editMessageText(chatId, messageId, finalText);
      return;
    } catch (err) {
      logger.warn("[Sessions] Failed to edit preview message, sending new one:", err);
    }
  }

  try {
    await api.sendMessage(chatId, finalText);
  } catch (err) {
    logger.error("[Sessions] Failed to send session preview message:", err);
  }
}
