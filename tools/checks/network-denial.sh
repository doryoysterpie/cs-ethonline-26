#!/usr/bin/env bash
# Runs a command with every network operation denied, on Linux, and proves
# the denial before trusting it. The macOS equivalent is the sandbox profile
# tools/offline-sandbox.sb; this script is the one continuous integration
# uses:
#
#   bash tools/checks/network-denial.sh pnpm test --force
#
# Method. A loopback probe starts a TCP listener on 127.0.0.1 and connects to
# it. Outside the sandbox it must connect (the positive control, which proves
# the probe itself works). Inside a fresh network namespace, where the only
# interface is a loopback that is down, the same probe must fail, and a
# connection to an outside address (192.0.2.1, TEST-NET-1, RFC 5737) must
# fail too: no interface and no route. Each must fail fast, with a connection
# error and not a timeout, which would mean a packet went somewhere. The proof
# runs in the same namespace as the command, in one invocation (D57): the
# command starts only after the proof holds there. The namespace is created
# with `unshare -rn` when unprivileged user namespaces are permitted, and
# otherwise through passwordless sudo, dropping back to the invoking user
# inside it. The caller's environment is carried into the namespace
# explicitly, through env(1): sudo-rs, the sudo of Ubuntu 26.04, ignores
# --preserve-env, and the command (pnpm under CI=true above all) behaves
# differently without it.
#
# `sudo` and `unshare` come from the runner image, the named exception to the
# pin posture (D57): the step verifies its own precondition on every run, and
# a failed proof prints the image and both tools' versions.
set -euo pipefail

# The caller's environment, read before this script sets a single variable, so
# a caller variable that shares a name with one of the script's own, the
# snapshot's included, is carried as the caller set it (review of 393b1d6, M1).
# NUL-separated, so no value can split.
mapfile -d '' -t NETWORK_DENIAL_ENVIRONMENT < <(env -0)

if [ "$#" -eq 0 ]; then
  echo "usage: network-denial.sh <command> [args...]" >&2
  exit 2
fi

loopback_probe='const net = require("node:net");
const server = net.createServer();
server.on("error", (error) => { console.log("error " + error.code); });
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const socket = net.connect(port, "127.0.0.1");
  socket.on("connect", () => { console.log("connected"); socket.destroy(); server.close(); });
  socket.on("error", (error) => { console.log("error " + error.code); server.close(); });
});'

# Inside the namespace: the loopback probe and one outside address, each given
# two seconds. A result is `error <code>`, `connected` or `timeout`.
inside_probe='const net = require("node:net");
const attempt = (start) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve("timeout"), 2000);
  start((result) => { clearTimeout(timer); resolve(result); });
});
const loopback = attempt((done) => {
  const server = net.createServer();
  server.on("error", (error) => done("error " + error.code));
  server.listen(0, "127.0.0.1", () => {
    const socket = net.connect(server.address().port, "127.0.0.1");
    socket.on("connect", () => { socket.destroy(); server.close(); done("connected"); });
    socket.on("error", (error) => { server.close(); done("error " + error.code); });
  });
});
const outside = attempt((done) => {
  const socket = net.connect(9, "192.0.2.1");
  socket.on("connect", () => { socket.destroy(); done("connected"); });
  socket.on("error", (error) => done("error " + error.code));
});
Promise.all([loopback, outside]).then(([a, b]) => {
  console.log("loopback=" + a + " outside=" + b);
  process.exit(0);
});'

outside="$(node -e "$loopback_probe")"
if [ "$outside" != "connected" ]; then
  echo "network-denial: control failed; the loopback probe reported '$outside' outside the sandbox" >&2
  exit 1
fi

if unshare -rn true 2>/dev/null; then
  deny=(unshare -rn --)
  mode="unprivileged user namespace"
  sudo_version="not used"
elif sudo -n true 2>/dev/null; then
  user="$(id -un)"
  deny=(sudo -n -- unshare -n -- sudo -n -u "$user" --)
  mode="root network namespace, command run as $user"
  sudo_version="$(sudo --version 2>/dev/null | head -n 1 || true)"
else
  echo "network-denial: unavailable; neither unprivileged user namespaces nor passwordless sudo" >&2
  exit 1
fi
unshare_version="$(unshare --version 2>/dev/null | head -n 1 || true)"
context="image ImageOS=${ImageOS:-unreported} ImageVersion=${ImageVersion:-unreported}; unshare: ${unshare_version:-unreported}; sudo: ${sudo_version:-unreported}"

# sudo resolves commands through its own secure path, not the caller's PATH,
# so the command and the tools the namespace needs are resolved here. A
# command path holding `=` would be read by env(1) as one more assignment, and
# is refused.
resolved="$(command -v "$1")" || {
  echo "network-denial: command not found: $1" >&2
  exit 127
}
shift
case "$resolved" in
  *=*)
    echo "network-denial: the command's path holds '=', which env would read as an assignment" >&2
    exit 2
    ;;
esac
node_path="$(command -v node)"
env_path="$(command -v env)"
bash_path="$(command -v bash)"

# One invocation, one namespace: an inner shell proves the denial where the
# command will run, then replaces itself with the command. The shell starts
# with an empty environment, so nothing of the caller's (BASH_ENV, SHELLOPTS,
# an exported function) acts on it; the caller's environment reaches it as
# arguments, counted, and reaches the command through `env -i --`, which takes
# every entry as an assignment, a name that begins with a dash included.
exec "${deny[@]}" "$env_path" -i -- "$bash_path" -c '
  set -euo pipefail
  node_path="$1" probe="$2" outside="$3" mode="$4" context="$5" env_path="$6" resolved="$7" count="$8"
  shift 8
  environment=("${@:1:count}")
  shift "$count"
  inside="$("$node_path" -e "$probe" 2>&1)" || inside="probe failed: $inside"
  case "$inside" in
    "loopback=error "[A-Z]*" outside=error "[A-Z]*) ;;
    *)
      echo "network-denial: not proven; inside the namespace the probes reported '\''$inside'\''; $context" >&2
      exit 1
      ;;
  esac
  echo "network-denial: proven ($mode); outside='\''$outside'\'' inside='\''$inside'\''; $context; running: $resolved $*"
  exec "$env_path" -i -- "${environment[@]}" "$resolved" "$@"
' network-denial "$node_path" "$inside_probe" "$outside" "$mode" "$context" "$env_path" "$resolved" \
  "${#NETWORK_DENIAL_ENVIRONMENT[@]}" "${NETWORK_DENIAL_ENVIRONMENT[@]}" "$@"
