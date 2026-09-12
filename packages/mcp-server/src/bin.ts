#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { SHUTDOWN_DEADLINE_MS } from './bounds.js';
import { assertCatalogueIntegrity } from './definitions.js';
import { createRuntime, ENVIRONMENT_NAMES } from './runtime.js';
import { sleep } from './safety/cancellation.js';
import { createCasMcpServer } from './server.js';
import { filterInbound, PolicyTransport } from './transport/policy.js';

/**
 * The stdio entry point, and the only transport this package enables.
 *
 * stdout is the protocol channel: nothing in this process writes to it except
 * the transport, and every message the transport writes has passed the
 * outbound error policy. Every diagnostic goes to stderr through the
 * runtime's redacting logger. The process reads four environment names and
 * no file, opens no listening socket, and exits when the client closes stdin,
 * on SIGINT or on SIGTERM: shutdown aborts every active call, waits a bounded
 * time for the work to unwind, closes the transport and the store, and exits
 * with the documented code whether or not something is still stuck.
 *
 * Before serving, the process asks the database who the configured credential
 * is. In production mode (the default) an overprivileged credential stops the
 * start with a fixed line and exit code 2; nothing is served and nothing is
 * read. In development mode the outcome is logged and the process serves. A
 * database that cannot be reached at start-up leaves the role unverified; the
 * store verifies again on every stored call's own connection before reading.
 */

function stderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<void> {
  assertCatalogueIntegrity();
  const env: Record<string, string | undefined> = {};
  for (const name of ENVIRONMENT_NAMES) env[name] = process.env[name];
  const runtime = createRuntime({ env, log: stderr });

  const role = await runtime.verifyDatabaseRole();
  if (role.status === 'overprivileged') {
    const checks = role.failed.join(',');
    if (runtime.mode === 'production') {
      runtime.log(
        `cas-mcp-server failed to start: database role overprivileged mode=production checks=${checks}`,
      );
      await runtime.close();
      process.exitCode = 2;
      return;
    }
    runtime.log(`cas-mcp-server database role overprivileged mode=development checks=${checks}`);
  } else if (role.status === 'unverified') {
    runtime.log(
      `cas-mcp-server database role unverified reason=${role.errorCode ?? 'unknown'}; every stored call verifies before it reads`,
    );
  }

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

  // stdin is filtered before the SDK's transport parses it: a well-formed
  // request whose `params` is not an object is answered with a fixed error
  // here, because the SDK discards it without a reply and the caller would
  // wait for one that never comes (Track D re-audit finding L4).
  let transport: PolicyTransport | null = null;
  const filtered = filterInbound(process.stdin, (refusal) => transport?.refuse(refusal));
  transport = new PolicyTransport(new StdioServerTransport(filtered), { redact: runtime.redact });
  const handle = serveStdio(() => createCasMcpServer(runtime), {
    transport,
    onerror: () => runtime.log('cas-mcp-server transport_error'),
  });
  process.stdin.on('end', () => shutdown('stdin_closed', 0));
  process.stdin.on('close', () => shutdown('stdin_closed', 0));
  process.on('SIGINT', () => shutdown('sigint', 130));
  process.on('SIGTERM', () => shutdown('sigterm', 143));
  runtime.log(
    `cas-mcp-server ready transport=stdio database=${runtime.store === null ? 'absent' : 'configured'} graph_credential=${runtime.live === null ? 'absent' : 'configured'} mode=${runtime.mode} database_role=${role.status}`,
  );
}

main().catch(() => {
  // The cause may carry a configuration value; only a fixed line leaves.
  stderr('cas-mcp-server failed to start: configuration rejected or catalogue integrity failed');
  process.exitCode = 2;
});
