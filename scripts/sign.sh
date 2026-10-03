#!/usr/bin/env bash
# Build and submit the extension to AMO for unlisted (self-distributed) signing. The maintainer runs this, not an agent.
# Needs AMO_JWT_ISSUER and AMO_JWT_SECRET in the environment. Their values are never printed.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
missing=()
[[ -n "${AMO_JWT_ISSUER:-}" ]] || missing+=(AMO_JWT_ISSUER)
[[ -n "${AMO_JWT_SECRET:-}" ]] || missing+=(AMO_JWT_SECRET)
if (( ${#missing[@]} )); then
  echo "sign: missing environment variable(s): ${missing[*]} (AMO API key pair from addons.mozilla.org/developers/addon/api/key/)" >&2
  exit 1
fi
npm run build
echo "sign: submitting extension/ to AMO (channel unlisted); this can take minutes"
npx web-ext sign \
  --source-dir extension \
  --artifacts-dir web-ext-artifacts \
  --ignore-files '**/*.ts' \
  --channel unlisted \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET"
xpi="$(/bin/ls -t web-ext-artifacts/*.xpi 2>/dev/null | head -n1 || true)"
if [[ -z "$xpi" ]]; then
  echo "sign: no .xpi found in web-ext-artifacts/ (signing may still be pending review)" >&2
  exit 1
fi
echo "sign: signed xpi: $repo/$xpi"
echo "sign: install it by opening that file in Firefox."
