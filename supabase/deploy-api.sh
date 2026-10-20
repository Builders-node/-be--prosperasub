#!/usr/bin/env bash
# Deploy the Edge API. `dev` → the api-dev function (what dev.everysub.net
# calls), `prod` → api (production). Always dev first; prod only once dev has
# been checked. Needs `npx supabase login` once on this machine.
set -euo pipefail
target="${1:-}"
case "$target" in
  dev)  name="api-dev" ;;
  prod) name="api" ;;
  *) echo "usage: $0 dev|prod" >&2; exit 1 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/supabase/functions"
cp -R "$here/functions/api" "$work/supabase/functions/$name"
cd "$work"
npx --yes supabase functions deploy "$name" --project-ref igbytraidldkhhamsfdo --no-verify-jwt --use-api
