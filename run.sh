#!/usr/bin/env bash
set -euo pipefail
PHPCODE_PRODUCT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$PHPCODE_PRODUCT_DIR/scripts/phpcode.cjs" exec "$@"
