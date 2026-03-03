import { createOpencodeClient } from "@opencode-ai/sdk";

const baseUrl = process.env.OPENCODE_API_URL ?? "http://localhost:4096";
const durationMs = Number(process.env.DURATION_MS ?? "10000");

const client = createOpencodeClient({ baseUrl });

const startedAt = Date.now();
const deadline = startedAt + durationMs;

const stopTimer = setInterval(() => {
  if (Date.now() >= deadline) {
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  }
}, 50);
stopTimer.unref();

const result = await client.global.event({
  onSseEvent: (sse) => {
    const elapsedMs = Date.now() - startedAt;
    const prefix = `[+${elapsedMs}ms]`;

    // hey-api wraps server-sent events like: { data: <payload>, retry?: number }
    const event = sse && typeof sse === "object" && "data" in sse ? sse.data : sse;
    const payloadType = event?.payload?.type;
    const directory = event?.directory;

    // Keep output single-line JSON for easy grepping.
    process.stdout.write(
      `${prefix} ${payloadType ?? "(unknown)"} dir=${directory ?? "(none)"} data=${JSON.stringify(event)}\n`,
    );
  },
  onSseError: (error) => {
    const elapsedMs = Date.now() - startedAt;
    process.stderr.write(`[+${elapsedMs}ms] SSE error: ${String(error)}\n`);
  },
});

// Keep the generator active.
for await (const _evt of result.stream) {
  if (Date.now() >= deadline) break;
}
