#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { assertCatalogueIntegrity } from './definitions.js';
import { createRuntime, ENVIRONMENT_NAMES } from './runtime.js';
import { createCasMcpServer } from './server.js';

/**
 * The stdio entry point, and the only transport this package enables.
 *
 * stdout is the protocol channel: nothing in this process writes to it except
 * the transport. Every diagnostic goes to stderr through the runtime's
 * redacting logger. The process reads three environment names and no file,
 * opens no listening socket, and exits when the client closes stdin, on
 * SIGINT or on SIGTERM, after closing the transport and the database pool.
 */

function stderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<void> {
  assertCatalogueIntegrity();
  const env: Record<string, string | undefined> = {};
  for (const name of ENVIRONMENT_NAMES) env[name] = process.env[name];
  const runtime = createRuntime({ env, log: stderr });

  let closing = false;
  const shutdown = (reason: string, code: number): void => {
    if (closing) return;
    closing = true;
    runtime.log(`cas-mcp-server shutdown reason=${reason}`);
    void Promise.allSettled([handle.close(), runtime.close()]).then(() => {
      process.exitCode = code;
    });
  };

  const handle = serveStdio(() => createCasMcpServer(runtime), {
    onerror: () => runtime.log('cas-mcp-server transport_error'),
  });
  process.stdin.on('end', () => shutdown('stdin_closed', 0));
  process.stdin.on('close', () => shutdown('stdin_closed', 0));
  process.on('SIGINT', () => shutdown('sigint', 130));
  process.on('SIGTERM', () => shutdown('sigterm', 143));
  runtime.log(
    `cas-mcp-server ready transport=stdio database=${runtime.store === null ? 'absent' : 'configured'} graph_credential=${runtime.live === null ? 'absent' : 'configured'}`,
  );
}

main().catch(() => {
  // The cause may carry a configuration value; only a fixed line leaves.
  stderr('cas-mcp-server failed to start: configuration rejected or catalogue integrity failed');
  process.exitCode = 2;
});
