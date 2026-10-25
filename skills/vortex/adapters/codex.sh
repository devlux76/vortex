#!/bin/sh
set -eu
cd "$(dirname "$(realpath "$0")")/../../.."
# Queue into a live app; only `wake` permits an absent app's headless resume.
exec bun skills/vortex/adapters/codex.mjs
