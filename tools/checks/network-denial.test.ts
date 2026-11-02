import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repositoryRoot } from './lib/tracked.ts';

const SCRIPT = path.join(repositoryRoot(), 'tools/checks/network-denial.sh');

// The script needs a Linux network namespace, through unprivileged user namespaces or
// passwordless sudo, as continuous integration has; anywhere else this suite is skipped, and
// its title says why. Unlike the other tool tests it opens sockets: the script's loopback
// control outside the namespace, and the command's attempts inside it, which must fail.
const AVAILABLE =
  process.platform === 'linux' &&
  (spawnSync('unshare', ['-rn', 'true']).status === 0 ||
    spawnSync('sudo', ['-n', 'true']).status === 0);

// Names the script and its inner shell use for their own variables, the snapshot's among them,
// and a name that begins with a dash: each must reach the command as the caller set it (review
// of 393b1d6, M1).
const NAMES = [
  'outside',
  'inside',
  'deny',
  'mode',
  'user',
  'resolved',
  'probe',
  'environment',
  'loopback_probe',
  'inside_probe',
  'sudo_version',
  'unshare_version',
  'context',
  'node_path',
  'env_path',
  'bash_path',
  'count',
  'NETWORK_DENIAL_ENVIRONMENT',
  '-FLAG',
  'MULTI',
  'EQ',
  'EMPTY',
];

describe.skipIf(!AVAILABLE)('network-denial.sh (Linux with a network namespace only)', () => {
  it('denies the network to the command and carries the caller environment unchanged', () => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const name of NAMES) env[name] = `caller-${name}`;
    env.MULTI = 'a\nb';
    env.EQ = 'x=y=z';
    env.EMPTY = '';
    const report = [
      `const names = ${JSON.stringify(NAMES)};`,
      'const net = require("node:net");',
      'const socket = net.connect(9, "192.0.2.1");',
      'socket.on("error", (error) => {',
      '  const seen = Object.fromEntries(names.map((name) => [name, process.env[name]]));',
      '  console.log(JSON.stringify({ connect: error.code, seen }));',
      '});',
      'socket.on("connect", () => { console.log(JSON.stringify({ connect: "connected" })); process.exit(1); });',
    ].join('\n');
    const result = spawnSync('bash', [SCRIPT, 'node', '-e', report], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^network-denial: proven /mu);
    const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      connect: string;
      seen: Record<string, string>;
    };
    expect(outcome.connect).toBe('ENETUNREACH');
    expect(outcome.seen).toEqual(Object.fromEntries(NAMES.map((name) => [name, env[name]])));
  });

  it('runs nothing of the caller environment before the command: BASH_ENV reaches it unchanged and is sourced once, by the script itself', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-network-denial-')));
    try {
      const log = path.join(root, 'sourced');
      const startup = path.join(root, 'startup.sh');
      fs.writeFileSync(startup, `echo sourced >> '${log}'\n`);
      const env = { ...process.env, BASH_ENV: startup } as Record<string, string>;
      const result = spawnSync(
        'bash',
        [SCRIPT, 'node', '-e', 'process.stdout.write("BASH_ENV=" + process.env.BASH_ENV)'],
        { env, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split('\n').at(-1)).toBe(`BASH_ENV=${startup}`);
      expect(fs.readFileSync(log, 'utf8')).toBe('sourced\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a command whose path holds "=", which env would read as one more assignment', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-network-denial-')));
    try {
      const command = path.join(root, 'a=b');
      fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = spawnSync('bash', [SCRIPT, command], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/the command's path holds '='/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
