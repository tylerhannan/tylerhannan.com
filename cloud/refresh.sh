#!/bin/sh
# Re-reads the site into ClickHouse and embeds what's new or changed (site.sql), once the site serves this
# checkout's files. Run by the search-refresh workflow. Needs CLICKHOUSE_URL and CLICKHOUSE_PASSWORD (site_refresher);
# without them it says so and exits 0.
set -eu
cd "$(dirname "$0")/.."
if [ -z "${CLICKHOUSE_URL:-}" ] || [ -z "${CLICKHOUSE_PASSWORD+set}" ]; then
  echo "cloud/refresh.sh: CLICKHOUSE_URL/PASSWORD not set, skipping the search refresh"
  exit 0
fi
BASE=${SITE_BASE:-$(sed -n "s/^ *'\([^']*\)' AS base,.*/\1/p" cloud/site.sql)}

echo "Waiting for $BASE to serve this commit's files…"
for i in $(seq 60); do
  stale=""
  for f in index.html photos/index.html archive/index.html archive/posts.json archive/text.json talks.json demos.json photos.json writing.json; do
    curl -sfL "$BASE/$f" | cmp -s - "public/$f" || stale="$stale $f"
  done
  [ -z "$stale" ] && break
  [ "$i" = 60 ] && { echo "Still stale after 10 minutes:$stale"; exit 1; }
  sleep 10
done

run() {  # one statement per request; the password goes in a header, not the URL
  curl -sS --fail-with-body "$CLICKHOUSE_URL/" -H "X-ClickHouse-User: ${CLICKHOUSE_USER:-site_refresher}" \
       -H "X-ClickHouse-Key: $CLICKHOUSE_PASSWORD" --data-binary "$1"
}
run "SYSTEM REFRESH VIEW site.pages"
run "SYSTEM WAIT VIEW site.pages"
run "SYSTEM REFRESH VIEW site.embed"
run "SYSTEM WAIT VIEW site.embed"
run "SELECT 'search refreshed: ' || toString(count()) || ' rows' FROM site.pages"
