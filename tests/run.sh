#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

for script in js/*.js tests/*.mjs nipplejs.min.js; do
  node --check "$script"
done

for suite in tests/*.test.mjs; do
  node "$suite"
done
