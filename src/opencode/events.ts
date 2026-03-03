import { opencodeClient } from "./client.js";
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2";
import { logger } from "../utils/logger.js";

type EventCallback = (event: Event, directory: string) => void;

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const FATAL_NO_STREAM_ERROR = "No stream returned from event subscription";

let eventStream: AsyncGenerator<GlobalEvent, unknown, unknown> | null = null;
let eventCallback: EventCallback | null = null;
let isListening = false;
let streamAbortController: AbortController | null = null;

function normalizeEventDirectory(globalEvent: GlobalEvent): string {
  const payload = globalEvent.payload as { properties?: unknown };
  const properties = payload.properties;

  if (globalEvent.directory) {
    return globalEvent.directory;
  }

  if (!properties || typeof properties !== "object") {
    return "";
  }

  const record = properties as Record<string, unknown>;
  const info = record.info;
  if (info && typeof info === "object") {
    const directory = (info as Record<string, unknown>).directory;
    if (typeof directory === "string") {
      return directory;
    }
  }

  return "";
}

function getReconnectDelayMs(attempt: number): number {
  const exponentialDelay = RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exponentialDelay, RECONNECT_MAX_DELAY_MS);
}

function waitWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };

    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function subscribeToEvents(directory: string, callback: EventCallback): Promise<void> {
  if (isListening) {
    eventCallback = callback;
    logger.debug("Global event listener already running");
    return;
  }

  const controller = new AbortController();

  eventCallback = callback;
  isListening = true;
  streamAbortController = controller;

  try {
    let reconnectAttempt = 0;

    while (isListening && !controller.signal.aborted) {
      try {
        logger.info("[Events] Starting global subscription: /global/event");
        const result = await opencodeClient.global.event({ signal: controller.signal });

        if (!result.stream) {
          throw new Error(FATAL_NO_STREAM_ERROR);
        }

        reconnectAttempt = 0;
        eventStream = result.stream;

        for await (const globalEvent of eventStream) {
          if (!isListening || controller.signal.aborted) {
            logger.debug("Global event listener stopped, breaking loop");
            break;
          }

          // CRITICAL: Explicitly yield to the event loop BEFORE processing the event
          // This allows grammY to handle getUpdates between SSE events
          await new Promise<void>((resolve) => setImmediate(resolve));

          if (eventCallback) {
            const event = globalEvent.payload;
            const eventDirectory = normalizeEventDirectory(globalEvent);
            // Use setImmediate to avoid blocking the event loop
            // and let grammY process incoming Telegram updates
            const callbackSnapshot = eventCallback;
            setImmediate(() => callbackSnapshot(event, eventDirectory));
          }
        }

        eventStream = null;

        if (!isListening || controller.signal.aborted) {
          break;
        }

        reconnectAttempt++;
        const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
        logger.warn(
          `[Events] Global stream ended, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})`,
        );

        const shouldContinue = await waitWithAbort(reconnectDelay, controller.signal);
        if (!shouldContinue) {
          break;
        }
      } catch (error) {
        eventStream = null;

        if (controller.signal.aborted || !isListening) {
          logger.info("[Events] Global listener aborted");
          return;
        }

        if (error instanceof Error && error.message === FATAL_NO_STREAM_ERROR) {
          logger.error("Event stream fatal error:", error);
          throw error;
        }

        reconnectAttempt++;
        const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
        logger.error(
          `[Events] Global stream error, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})`,
          error,
        );

        const shouldContinue = await waitWithAbort(reconnectDelay, controller.signal);
        if (!shouldContinue) {
          break;
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      logger.info("[Events] Global listener aborted");
      return;
    }

    logger.error("[Events] Global stream error:", error);
    isListening = false;
    streamAbortController = null;
    throw error;
  } finally {
    if (streamAbortController === controller) {
      if (isListening && !controller.signal.aborted) {
        logger.warn("[Events] Global stream ended, listener marked as disconnected");
      }

      streamAbortController = null;
      eventStream = null;
      eventCallback = null;
      isListening = false;
    }
  }
}

export function stopEventListening(): void {
  streamAbortController?.abort();
  streamAbortController = null;
  isListening = false;
  eventCallback = null;
  eventStream = null;
  logger.info("[Events] Global listener stopped");
}

export async function subscribeToEventsMulti(
  _directories: string[],
  callback: EventCallback,
): Promise<void> {
  await subscribeToEvents("global", callback);
}

export function stopAllEventListening(): void {
  stopEventListening();
}

export function getSubscribedDirectories(): string[] {
  return isListening ? ["*"] : [];
}
