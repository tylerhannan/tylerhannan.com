#!/bin/sh
# Re-reads the live site into ClickHouse and embeds whatever is new or changed (cloud/site.sql).
# Run after each deploy: the Workers Build deploy command is
#
#   npx wrangler deploy && sh cloud/refresh.sh
#
# so it runs once the new files are live. Needs CLICKHOUSE_URL (https://<service>:8443), CLICKHOUSE_USER and
# CLICKHOUSE_PASSWORD as build secrets; without them it says so and exits 0, so a deploy never fails on it.
# The user only needs: GRANT SYSTEM VIEWS, SELECT ON site.* TO <user> (WAIT VIEW: confirm on Cloud)
set -eu
if [ -z "${CLICKHOUSE_URL:-}" ] || [ -z "${CLICKHOUSE_USER:-}" ] || [ -z "${CLICKHOUSE_PASSWORD+set}" ]; then
  echo "cloud/refresh.sh: CLICKHOUSE_URL/USER/PASSWORD not set, skipping the search refresh"
  exit 0
fi
run() {  # one statement per request; the password goes in a header, not the URL
  curl -sS --fail-with-body "$CLICKHOUSE_URL/" -H "X-ClickHouse-User: $CLICKHOUSE_USER" \
       -H "X-ClickHouse-Key: $CLICKHOUSE_PASSWORD" --data-binary "$1"
}
run "SYSTEM REFRESH VIEW site.pages"
run "SYSTEM WAIT VIEW site.pages"
run "SYSTEM REFRESH VIEW site.embed"
run "SYSTEM WAIT VIEW site.embed"
run "SELECT 'search refreshed: ' || toString(count()) || ' rows' FROM site.pages"
