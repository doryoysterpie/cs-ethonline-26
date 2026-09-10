#!/usr/bin/env node
import { createRuntime, ENVIRONMENT_NAMES } from './runtime.js';
import { toToolError } from './safety/errors.js';

/**
 * The privilege verification command: `corepack pnpm mcp:verify-role`.
 *
 * Connects with the server's own `DATABASE_URL`, runs the same privilege
 * matrix the server runs at start-up and before every stored read, and prints
 * one fixed line per check. Nothing it prints is read from the database as
 * text: the lines carry check codes and pass/fail only, never a role name, a
 * table name from the catalogue, a driver message or a credential.
 *
 * Exit codes: 0 when every check passes, 1 when the credential is
 * overprivileged, 2 when the database is not configured, rejected or cannot
 * be reached.
 */

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const env: Record<string, string | undefined> = {};
  for (const name of ENVIRONMENT_NAMES) env[name] = process.env[name];
  const runtime = createRuntime({ env, log: (line) => process.stderr.write(`${line}\n`) });
  try {
    if (runtime.store === null) {
      out('cas-mcp-verify-role status=absent reason=database_not_configured');
      return 2;
    }
    let report;
    try {
      report = await runtime.store.verifyPrivileges();
    } catch (error) {
      out(`cas-mcp-verify-role status=unverified reason=${toToolError(error).code}`);
      return 2;
    }
    for (const check of report.checks) {
      out(`cas-mcp-verify-role check=${check.code} result=${check.ok ? 'pass' : 'fail'}`);
    }
    out(
      `cas-mcp-verify-role status=${report.ok ? 'verified' : 'overprivileged'} mode=${runtime.mode} failed=${report.failed.length}`,
    );
    return report.ok ? 0 : 1;
  } finally {
    await runtime.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    // The cause may carry a configuration value; only a fixed line leaves.
    process.stderr.write('cas-mcp-verify-role failed: configuration rejected\n');
    process.exitCode = 2;
  });
