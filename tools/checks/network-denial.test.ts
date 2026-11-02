import { spawnSync } from 'node:child_process';
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

// Names the script uses for its own variables, the snapshot's among them, and a name that
// begins with a dash: each must reach the command as the caller set it (review of 393b1d6, M1).
const NAMES = [
  'outside',
  'inside',
  'deny',
  'mode',
  'user',
  'resolved',
  'probe',
  'environment',
  'shell',
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
});
