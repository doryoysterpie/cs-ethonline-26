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
# the invoking user inside it.
set -euo pipefail

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
  deny=(unshare -rn)
  mode="unprivileged user namespace"
elif sudo -n true 2>/dev/null; then
  user="$(id -un)"
  deny=(sudo -n --preserve-env unshare -n -- sudo -n --preserve-env -u "$user")
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
# so the command is resolved here and the PATH is carried in explicitly.
resolved="$(command -v "$1")" || {
  echo "network-denial: command not found: $1" >&2
  exit 127
}
shift

echo "network-denial: proven ($mode); outside='$outside' inside='$inside'; running: $resolved $*"
exec "${deny[@]}" env "PATH=$PATH" "$resolved" "$@"
