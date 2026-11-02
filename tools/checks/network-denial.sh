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
# interface is a loopback that is down, the same probe must fail. Only after
# both results are observed is the command run inside that namespace. The
# namespace is created with `unshare -rn` when unprivileged user namespaces
# are permitted, and otherwise through passwordless sudo, dropping back to
# the invoking user inside it. The caller's environment is carried into the
# namespace explicitly, through env(1): sudo-rs, the sudo of Ubuntu 26.04,
# ignores --preserve-env, and the command (pnpm under CI=true above all)
# behaves differently without it.
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

probe='const net = require("node:net");
const server = net.createServer();
server.on("error", (error) => { console.log("error " + error.code); });
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const socket = net.connect(port, "127.0.0.1");
  socket.on("connect", () => { console.log("connected"); socket.destroy(); server.close(); });
  socket.on("error", (error) => { console.log("error " + error.code); server.close(); });
});'

outside="$(node -e "$probe")"
if [ "$outside" != "connected" ]; then
  echo "network-denial: control failed; the loopback probe reported '$outside' outside the sandbox" >&2
  exit 1
fi

if unshare -rn true 2>/dev/null; then
  deny=(unshare -rn --)
  mode="unprivileged user namespace"
elif sudo -n true 2>/dev/null; then
  user="$(id -un)"
  deny=(sudo -n -- unshare -n -- sudo -n -u "$user" --)
  mode="root network namespace, command run as $user"
else
  echo "network-denial: unavailable; neither unprivileged user namespaces nor passwordless sudo" >&2
  exit 1
fi

inside="$("${deny[@]}" node -e "$probe")"
case "$inside" in
  error\ *) ;;
  *)
    echo "network-denial: not proven; the loopback probe reported '$inside' inside the sandbox" >&2
    exit 1
    ;;
esac

# sudo resolves commands through its own secure path, not the caller's PATH,
# so the command is resolved here, and the caller's whole environment, PATH
# included, is carried in explicitly from the snapshot above. `env -i --` takes
# every entry as an assignment, a name that begins with a dash included, and
# the command runs through bash, so a command path holding `=` is never read as
# one more assignment.
resolved="$(command -v "$1")" || {
  echo "network-denial: command not found: $1" >&2
  exit 127
}
shift
shell="$(command -v bash)"

echo "network-denial: proven ($mode); outside='$outside' inside='$inside'; running: $resolved $*"
exec "${deny[@]}" env -i -- "${NETWORK_DENIAL_ENVIRONMENT[@]}" "$shell" -c 'exec "$@"' network-denial "$resolved" "$@"
