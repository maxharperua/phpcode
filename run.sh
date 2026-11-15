#!/bin/sh
set -eu
PHPCODE_PRODUCT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PATH="$PHPCODE_PRODUCT_DIR/../tools/phpcode-build/node-v24.22.1-darwin-arm64/bin:$PHPCODE_PRODUCT_DIR/../tools/phpcode-build/node_modules/.bin:$PATH"
export PNPM_CONFIG_FROZEN_LOCKFILE=true
cd "$PHPCODE_PRODUCT_DIR/../phpcode-oss"
exec "$@"
