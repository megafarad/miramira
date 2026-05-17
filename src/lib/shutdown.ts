// Wrap a graceful-shutdown promise in a watchdog: if it does not resolve
// within `timeoutMs`, log and force-exit non-zero. Use for both the HTTP
// server (app.close()) and the worker (worker.run() drain). Container
// orchestrators send SIGTERM and wait a fixed grace period before SIGKILL;
// without a watchdog, an OpenFGA call that never returns would hang until
// SIGKILL with no diagnostic trace.

export interface ShutdownLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export async function withShutdownTimeout(
  task: Promise<void>,
  timeoutMs: number,
  logger: ShutdownLogger,
  what: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([task.then(() => 'ok' as const), timeout]);
    if (result === 'timeout') {
      logger.error(
        { what, timeoutMs },
        'shutdown exceeded timeout; forcing exit (orchestrator would SIGKILL soon)',
      );
      process.exit(1);
    }
    logger.info({ what }, 'shutdown drained cleanly');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
