#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { SHUTDOWN_DEADLINE_MS } from './bounds.js';
import { assertCatalogueIntegrity } from './definitions.js';
import { createRuntime, ENVIRONMENT_NAMES } from './runtime.js';
import { sleep } from './safety/cancellation.js';
import { createCasMcpServer } from './server.js';
import { PolicyTransport } from './transport/policy.js';

/**
 * The stdio entry point, and the only transport this package enables.
 *
 * stdout is the protocol channel: nothing in this process writes to it except
 * the transport, and every message the transport writes has passed the
 * outbound error policy. Every diagnostic goes to stderr through the
 * runtime's redacting logger. The process reads three environment names and
 * no file, opens no listening socket, and exits when the client closes stdin,
 * on SIGINT or on SIGTERM: shutdown aborts every active call, waits a bounded
 * time for the work to unwind, closes the transport and the pools, and exits
 * with the documented code whether or not something is still stuck.
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
    const finished = Promise.allSettled([runtime.close(), handle.close()]).then(() => true);
    const expired = sleep(SHUTDOWN_DEADLINE_MS + 1_000).then(() => false);
    void Promise.race([finished, expired]).then((clean) => {
      runtime.log(`cas-mcp-server exit code=${code} clean=${clean}`);
      process.exit(code);
    });
  };

  const transport = new PolicyTransport(new StdioServerTransport(), { redact: runtime.redact });
  const handle = serveStdio(() => createCasMcpServer(runtime), {
    transport,
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
