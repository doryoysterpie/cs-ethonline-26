#!/usr/bin/env node
// Demonstrates, in the same session as a test run, what a macOS sandbox
// profile actually permits. Run it under the profile whose claim is being
// checked:
//
//   sandbox-exec -f tools/offline-sandbox.sb node tools/sandbox-probe.mjs
//   sandbox-exec -f tools/loopback-sandbox.sb node tools/sandbox-probe.mjs
//
// It contacts no other machine: the only address it connects to that is not
// this host's own is a public one it requires to be refused. Every result is
// printed as observed, so a profile that stops matching its documentation
// shows up here rather than in a claim.
import { networkInterfaces } from 'node:os';
import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';
import { unlinkSync } from 'node:fs';

const results = [];
const record = (name, outcome) => {
  results.push([name, outcome]);
  console.log(`${name.padEnd(42)} ${outcome}`);
};

function connect(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(outcome);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => done('TIMEOUT'));
    socket.on('connect', () => done('CONNECTED'));
    socket.on('error', (error) => done(error.code ?? error.message));
  });
}

function listenThenConnect(host) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        /* already gone */
      }
      resolve(outcome);
    };
    const server = net.createServer((socket) => socket.end('ok'));
    server.on('error', (error) => done(`LISTEN_${error.code ?? error.message}`));
    try {
      server.listen(0, host, () => {
        const client = net.connect({ host, port: server.address().port });
        client.setTimeout(4000, () => done('CONNECT_TIMEOUT'));
        client.on('connect', () => {
          client.destroy();
          done('LISTEN_AND_CONNECT_OK');
        });
        client.on('error', (error) => done(`CONNECT_${error.code ?? error.message}`));
      });
    } catch (error) {
      done(`LISTEN_THROW_${error.code ?? error.message}`);
    }
  });
}

function resolveName(name) {
  return new Promise((resolve) => {
    dns.lookup(name, (error, address) =>
      resolve(error ? (error.code ?? error.message) : `RESOLVED_${address}`),
    );
  });
}

function unixSocket() {
  return new Promise((resolve) => {
    const path = `/tmp/cas-sandbox-probe-${process.pid}.sock`;
    const server = net.createServer(() => {});
    server.on('error', (error) => resolve(`LISTEN_${error.code ?? error.message}`));
    try {
      server.listen(path, () => {
        server.close();
        try {
          unlinkSync(path);
        } catch {
          /* nothing to remove */
        }
        resolve('LISTEN_OK');
      });
    } catch (error) {
      resolve(`THROW_${error.code ?? error.message}`);
    }
  });
}

/** The first address assigned to this host that is not a loopback address. */
function localNonLoopback() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.family === 'IPv4') return address.address;
    }
  }
  return null;
}

record('public IPv4 1.1.1.1:443', await connect('1.1.1.1', 443));
record('public IPv6 cloudflare:443', await connect('2606:4700:4700::1111', 443));
record('DNS lookup example.com', await resolveName('example.com'));
record('loopback IPv4 127.0.0.1', await listenThenConnect('127.0.0.1'));
record('loopback IPv6 ::1', await listenThenConnect('::1'));
record('UNIX domain socket', await unixSocket());

const local = localNonLoopback();
if (local === null) {
  record('local non-loopback address', 'SKIPPED_NO_NON_LOOPBACK_ADDRESS');
} else {
  record(`local non-loopback ${local}`, await listenThenConnect(local));
}

const child = spawnSync(
  process.execPath,
  [
    '-e',
    "require('node:net').connect(443,'1.1.1.1')" +
      ".on('error',e=>{console.log(e.code);process.exit(0)})" +
      ".on('connect',()=>{console.log('CONNECTED');process.exit(0)});" +
      'setTimeout(()=>{console.log("TIMEOUT");process.exit(0)},4000)',
  ],
  { encoding: 'utf8', timeout: 15_000 },
);
record('subprocess public IPv4', (child.stdout ?? '').trim() || 'NO_OUTPUT');

// A profile must always deny every host off this machine.
const offHost = results.filter(
  ([name]) => name.startsWith('public ') || name.startsWith('subprocess '),
);
const reachedOffHost = offHost.filter(([, outcome]) => outcome === 'CONNECTED');
if (reachedOffHost.length > 0) {
  console.error(
    `\nFAILED: reached a host off this machine: ${reachedOffHost.map(([n]) => n).join(', ')}`,
  );
  process.exit(1);
}
console.log('\nNo host off this machine was reached.');
