import { opencodeClient } from "./client.js";
import { Event } from "@opencode-ai/sdk/v2";
import { logger } from "../utils/logger.js";

type EventCallback = (event: Event, directory: string) => void;

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const FATAL_NO_STREAM_ERROR = "No stream returned from event subscription";

// Legacy single-directory state (kept for backward compatibility)
let eventStream: AsyncGenerator<Event, unknown, unknown> | null = null;
let eventCallback: EventCallback | null = null;
let isListening = false;
let activeDirectory: string | null = null;
let streamAbortController: AbortController | null = null;

// Multi-directory subscription state
type DirectorySubscription = {
  abortController: AbortController;
  stream: AsyncGenerator<Event, unknown, unknown> | null;
  isActive: boolean;
};

const directorySubscriptions = new Map<string, DirectorySubscription>();
let globalEventCallback: EventCallback | null = null;

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
  if (isListening && activeDirectory === directory) {
    eventCallback = callback;
    logger.debug(`Event listener already running for ${directory}`);
    return;
  }

  if (isListening && activeDirectory !== directory) {
    logger.info(`Stopping event listener for ${activeDirectory}, starting for ${directory}`);
    streamAbortController?.abort();
    streamAbortController = null;
    isListening = false;
    activeDirectory = null;
  }

  const controller = new AbortController();

  activeDirectory = directory;
  eventCallback = callback;
  isListening = true;
  streamAbortController = controller;

  try {
    let reconnectAttempt = 0;

    while (isListening && activeDirectory === directory && !controller.signal.aborted) {
      try {
        const result = await opencodeClient.event.subscribe(
          { directory },
          { signal: controller.signal },
        );

        if (!result.stream) {
          throw new Error(FATAL_NO_STREAM_ERROR);
        }

        reconnectAttempt = 0;
        eventStream = result.stream;

        for await (const event of eventStream) {
          if (!isListening || activeDirectory !== directory || controller.signal.aborted) {
            logger.debug(`Event listener stopped or changed directory, breaking loop`);
            break;
          }

          // CRITICAL: Explicitly yield to the event loop BEFORE processing the event
          // This allows grammY to handle getUpdates between SSE events
          await new Promise<void>((resolve) => setImmediate(resolve));

          if (eventCallback) {
            // Use setImmediate to avoid blocking the event loop
            // and let grammY process incoming Telegram updates
            const callbackSnapshot = eventCallback;
            setImmediate(() => callbackSnapshot(event, directory));
          }
        }

        eventStream = null;

        if (!isListening || activeDirectory !== directory || controller.signal.aborted) {
          break;
        }

        reconnectAttempt++;
        const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
        logger.warn(
          `Event stream ended for ${directory}, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})`,
        );

        const shouldContinue = await waitWithAbort(reconnectDelay, controller.signal);
        if (!shouldContinue) {
          break;
        }
      } catch (error) {
        eventStream = null;

        if (controller.signal.aborted || !isListening || activeDirectory !== directory) {
          logger.info("Event listener aborted");
          return;
        }

        if (error instanceof Error && error.message === FATAL_NO_STREAM_ERROR) {
          logger.error("Event stream fatal error:", error);
          throw error;
        }

        reconnectAttempt++;
        const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
        logger.error(
          `Event stream error for ${directory}, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})`,
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
      logger.info("Event listener aborted");
      return;
    }

    logger.error("Event stream error:", error);
    isListening = false;
    activeDirectory = null;
    streamAbortController = null;
    throw error;
  } finally {
    if (streamAbortController === controller) {
      if (isListening && activeDirectory === directory && !controller.signal.aborted) {
        logger.warn(`Event stream ended for ${directory}, listener marked as disconnected`);
      }

      streamAbortController = null;
      eventStream = null;
      eventCallback = null;
      isListening = false;
      activeDirectory = null;
    }
  }
}

export function stopEventListening(): void {
  streamAbortController?.abort();
  streamAbortController = null;
  isListening = false;
  eventCallback = null;
  eventStream = null;
  activeDirectory = null;
  logger.info("Event listener stopped");
}

/**
 * Subscribe to events from multiple directories simultaneously.
 * Each directory gets its own SSE stream and reconnection logic.
 */
export async function subscribeToEventsMulti(
  directories: string[],
  callback: EventCallback,
): Promise<void> {
  globalEventCallback = callback;

  // Stop subscriptions for directories no longer in the list
  for (const [dir, sub] of directorySubscriptions.entries()) {
    if (!directories.includes(dir)) {
      logger.info(`[Events] Stopping subscription for directory: ${dir}`);
      sub.abortController.abort();
      sub.isActive = false;
      directorySubscriptions.delete(dir);
    }
  }

  // Start new subscriptions for directories not yet subscribed
  for (const dir of directories) {
    if (!directorySubscriptions.has(dir)) {
      logger.info(`[Events] Starting subscription for directory: ${dir}`);
      const controller = new AbortController();
      const sub: DirectorySubscription = {
        abortController: controller,
        stream: null,
        isActive: true,
      };
      directorySubscriptions.set(dir, sub);
      // Start listening in background
      runDirectoryListener(dir, sub).catch((err) => {
        logger.error(`[Events] Directory listener error for ${dir}:`, err);
      });
    }
  }
}

async function runDirectoryListener(
  directory: string,
  sub: DirectorySubscription,
): Promise<void> {
  let reconnectAttempt = 0;

  while (sub.isActive && !sub.abortController.signal.aborted) {
    try {
      const result = await opencodeClient.event.subscribe(
        { directory },
        { signal: sub.abortController.signal },
      );

      if (!result.stream) {
        throw new Error(FATAL_NO_STREAM_ERROR);
      }

      reconnectAttempt = 0;
      sub.stream = result.stream;

      for await (const event of sub.stream) {
        if (!sub.isActive || sub.abortController.signal.aborted) {
          break;
        }

        // Yield to event loop
        await new Promise<void>((resolve) => setImmediate(resolve));

        if (globalEventCallback) {
          const callbackSnapshot = globalEventCallback;
          setImmediate(() => callbackSnapshot(event, directory));
        }
      }

      sub.stream = null;

      if (!sub.isActive || sub.abortController.signal.aborted) {
        break;
      }

      reconnectAttempt++;
      const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
      logger.warn(
        `[Events] Stream ended for ${directory}, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})`,
      );

      const shouldContinue = await waitWithAbort(reconnectDelay, sub.abortController.signal);
      if (!shouldContinue) {
        break;
      }
    } catch (error) {
      sub.stream = null;

      if (sub.abortController.signal.aborted || !sub.isActive) {
        logger.info(`[Events] Listener aborted for ${directory}`);
        return;
      }

      if (error instanceof Error && error.message === FATAL_NO_STREAM_ERROR) {
        logger.error(`[Events] Fatal stream error for ${directory}:`, error);
        throw error;
      }

      reconnectAttempt++;
      const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
      logger.error(
        `[Events] Stream error for ${directory}, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})`,
        error,
      );

      const shouldContinue = await waitWithAbort(reconnectDelay, sub.abortController.signal);
      if (!shouldContinue) {
        break;
      }
    }
  }

  logger.info(`[Events] Listener stopped for directory: ${directory}`);
}

/**
 * Stop all directory subscriptions.
 */
export function stopAllEventListening(): void {
  for (const [dir, sub] of directorySubscriptions.entries()) {
    logger.info(`[Events] Stopping subscription for ${dir}`);
    sub.abortController.abort();
    sub.isActive = false;
  }
  directorySubscriptions.clear();
  globalEventCallback = null;
}

/**
 * Get list of currently subscribed directories.
 */
export function getSubscribedDirectories(): string[] {
  return Array.from(directorySubscriptions.keys());
}
