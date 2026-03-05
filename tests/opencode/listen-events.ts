// Usage: npx tsx tests/opencode/listen-events.ts
// Connects to /global/event and /event?directory=... on a running OpenCode server.

const BASE_URL = process.env.OPENCODE_URL ?? "http://localhost:4096";
const DIRECTORY = "/Users/fingerfrings/temp/opencode-telegram-bot-test/test1";

function ts(): string {
  return new Date().toISOString();
}

function color(tag: string, code: number): string {
  return `\x1b[${code}m${tag}\x1b[0m`;
}

const TAG_GLOBAL = color("[GLOBAL]", 36);
const TAG_DIR = color("[DIR]   ", 33);
const TAG_SYS = color("[SYS]   ", 90);

function isHeartbeat(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  if (obj.type === "server.heartbeat") return true;
  if (typeof obj.payload === "object" && obj.payload !== null) {
    return (obj.payload as Record<string, unknown>).type === "server.heartbeat";
  }
  return false;
}

function log(tag: string, msg: string, data?: unknown): void {
  const line = `${ts()} ${tag} ${msg}`;
  if (data !== undefined) {
    console.log(line, JSON.stringify(data, null, 2));
  } else {
    console.log(line);
  }
}

async function listenSSE(url: string, tag: string, signal: AbortSignal): Promise<void> {
  log(tag, `Connecting to ${url} ...`);

  const res = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }

  if (!res.body) {
    throw new Error(`No response body from ${url}`);
  }

  log(tag, "Connected. Waiting for events...");

  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        log(tag, "Stream ended by server.");
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const raw of parts) {
        if (!raw.trim()) continue;

        let eventType = "message";
        const dataLines: string[] = [];

        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }

        const dataStr = dataLines.join("\n");
        let parsed: unknown;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          parsed = dataStr;
        }

        if (isHeartbeat(parsed)) continue;
        log(tag, `event=${eventType}`, parsed);
      }
    }
  } catch (err: unknown) {
    if (signal.aborted) return;
    throw err;
  }
}

async function listenWithReconnect(url: string, tag: string, signal: AbortSignal): Promise<void> {
  let attempt = 0;

  while (!signal.aborted) {
    try {
      attempt++;
      await listenSSE(url, tag, signal);

      if (signal.aborted) return;

      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 15000);
      log(tag, `Reconnecting in ${delay}ms (attempt=${attempt})...`);
      await sleep(delay, signal);
    } catch (err: unknown) {
      if (signal.aborted) return;

      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 15000);
      log(tag, `Error: ${(err as Error).message}. Retrying in ${delay}ms (attempt=${attempt})...`);
      await sleep(delay, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function main(): Promise<void> {
  const ac = new AbortController();

  process.on("SIGINT", () => {
    log(TAG_SYS, "Ctrl+C received, shutting down...");
    ac.abort();
  });
  process.on("SIGTERM", () => {
    ac.abort();
  });

  const globalUrl = `${BASE_URL}/global/event`;
  const dirUrl = `${BASE_URL}/event?directory=${encodeURIComponent(DIRECTORY)}`;

  log(TAG_SYS, `OpenCode server: ${BASE_URL}`);
  log(TAG_SYS, `Global endpoint: ${globalUrl}`);
  log(TAG_SYS, `Directory endpoint: ${dirUrl}`);
  log(TAG_SYS, `Watched directory: ${DIRECTORY}`);
  log(TAG_SYS, "Press Ctrl+C to stop.\n");

  await Promise.allSettled([
    listenWithReconnect(globalUrl, TAG_GLOBAL, ac.signal),
    listenWithReconnect(dirUrl, TAG_DIR, ac.signal),
  ]);

  log(TAG_SYS, "All listeners stopped.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
