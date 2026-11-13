#!/bin/sh
# Runs the local web server on Linux/macOS (Node.js 18+).
# Port 80 needs root there; to avoid that, set "port" in config/server.json
# (or LEGACY_WEB_PORT=8080) and point the clients' BaseUrl at that port.
cd "$(dirname "$0")" || exit 1
exec node Webserver/node/server.js "$@"
