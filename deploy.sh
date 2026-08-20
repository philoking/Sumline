#!/usr/bin/env bash
#
# Pull and redeploy Sumline on the host this clone lives on.
#
# This is what the CI pipeline used to be: the same four gates in the same
# order — run the suite inside the image, build, bring the stack up, then prove
# the deployed engine actually answers — except a person decides when, instead
# of every push to main.
#
# Run it from anywhere; it works on its own directory, not the caller's.
set -euo pipefail

cd "$(cd "$(dirname "$0")" && pwd)"

BASE=http://127.0.0.1:8422
ENV_FILE="$PWD/.env"

# Two of these at once would race `compose up` against the same container and
# the same sheets volume. Held for the whole run and released however the shell
# exits. This is what the pipeline's `cancel-in-progress: false` bought.
exec 9>"/tmp/sumline-deploy.lock"
if ! flock -n 9; then
  echo "Another deploy is already running." >&2
  exit 1
fi

say() { printf '\n== %s\n' "$1"; }

say "Updating"
# --ff-only: a diverged or dirty checkout stops the deploy and says so, rather
# than being merged into something nobody has read.
git pull --ff-only

say "Testing"
# The whole suite, inside the image, against the Node that actually ships.
# Nothing else stands between a red commit and this host.
#
# --network=host: build steps use the host's resolver. The default container
# DNS drops npm's burst of tarball fetches (EAI_AGAIN).
docker build --network=host --target test -t sumline:test .

say "Building"
# Reuses the layers the test stage just built, so this is nearly free.
docker build --network=host -t sumline:latest .

say "Starting"
# The project name is pinned inside the compose file, so there is no -p to
# forget and no way to land on an empty database by running this from the
# wrong directory.
docker compose -f docker-compose.prod.yml up -d
docker image prune -f

say "Waiting for it to serve"
# A container that starts is not the same as an app that serves.
served=""
for attempt in $(seq 1 30); do
  if curl -fsS "$BASE/api/health" >/dev/null; then
    echo "Serving after ${attempt} attempt(s)."
    served=yes
    break
  fi
  sleep 2
done
if [ -z "$served" ]; then
  echo "Sumline did not become healthy within 60s." >&2
  docker logs --tail 50 sumline || true
  exit 1
fi

say "Asking the engine a question"
# /api/health is equally true of a container serving a broken engine: it reports
# that the process is up and which date its rates carry, and nothing about
# whether a sheet would answer.
#
# No jq: this is the last gate on every deploy, so it depends on nothing the
# host might not have. The response shape is fixed and this is its only reader.
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

PASSWORD=""
if [ -f "$ENV_FILE" ]; then
  PASSWORD=$(sed -n 's/^SUMLINE_PASSWORD=//p' "$ENV_FILE" | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
fi
if [ -n "$PASSWORD" ]; then
  # Without signing in, the request would 401 and this would be testing the
  # guard rather than the engine.
  ESCAPED=$(printf '%s' "$PASSWORD" | sed -e 's/\/\\/g' -e 's/"/\\"/g')
  curl -fsS -c "$JAR" -X POST "$BASE/api/session" \
    -H 'content-type: application/json' \
    -d "{\"password\":\"$ESCAPED\"}" >/dev/null
fi

# Currency exercises the rate table as well as the arithmetic, and a unit
# conversion reaches parts of the engine a plain sum does not.
BODY='{"input":["2 + 2 * 10","10 km in miles","100 USD in EUR"]}'
# Captured whole first, so a 401 or a 500 is reported as itself rather than as
# an empty answer to the arithmetic.
if ! RESPONSE=$(curl -fsS -b "$JAR" -X POST "$BASE/api/evaluate" \
  -H 'content-type: application/json' -d "$BODY"); then
  echo "The deployed instance would not answer /api/evaluate." >&2
  echo "If it has a password, check SUMLINE_PASSWORD in $ENV_FILE." >&2
  docker logs --tail 50 sumline || true
  exit 1
fi

# `|| true` because a no-match grep would otherwise abort under `set -o
# pipefail` with no explanation at all; the emptiness is reported below instead.
ANSWERS=$(printf '%s' "$RESPONSE" | grep -o '"output":"[^"]*"' | sed 's/"output":"//;s/"$//' || true)
if [ -z "$ANSWERS" ]; then
  echo "The deployed engine returned no answers at all." >&2
  docker logs --tail 50 sumline || true
  exit 1
fi
echo "$ANSWERS"

FIRST=$(echo "$ANSWERS" | sed -n 1p)
if [ "$FIRST" != "22" ]; then
  echo "The deployed engine answered '$FIRST' rather than 22." >&2
  docker logs --tail 50 sumline || true
  exit 1
fi
# The other two depend on the live rates and on the instance's region, so what
# is checked is that they were answered at all.
if [ "$(echo "$ANSWERS" | sed -n '2p;3p' | grep -c .)" != "2" ]; then
  echo "The deployed engine left a conversion unanswered." >&2
  docker logs --tail 50 sumline || true
  exit 1
fi

say "Deployed"
