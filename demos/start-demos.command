#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec python3 -m http.server 8766 --bind 127.0.0.1 --directory "$ROOT"
