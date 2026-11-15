#!/bin/sh
# Prints scripts/ch UPDATEs for whatever the JSON is missing: `summaries` (aiGenerate) or `topics` (aiClassify).
set -eu
cd "$(dirname "$0")/.."
if [ -z "${CLICKHOUSE_URL:-}" ] || [ -z "${CLICKHOUSE_PASSWORD+set}" ]; then
  echo "cloud/enrich.sh: CLICKHOUSE_URL/PASSWORD not set, skipping" >&2
  exit 0
fi
BASE=${SITE_BASE:-https://raw.githubusercontent.com/tylerhannan/tylerhannan.com/$(git rev-parse HEAD)/public}
enc() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
run() {  # SQL file or text, then name=value parameters
  sql=$1; shift; q="param_base=$(enc "$BASE")"
  for kv in "$@"; do q="$q&param_${kv%%=*}=$(enc "${kv#*=}")"; done
  if [ -f "$sql" ]; then set -- --data-binary "@$sql"; else set -- --data-binary "$sql"; fi
  curl -sS --fail-with-body "$CLICKHOUSE_URL/?$q" -H "X-ClickHouse-User: ${CLICKHOUSE_USER:-site_enricher}" \
       -H "X-ClickHouse-Key: $CLICKHOUSE_PASSWORD" "$@"
}

case "${1:-}" in
  summaries)
    run "SELECT JSONExtractString(w, 'url') FROM url({base:String} || '/writing.json', RawBLOB)
         ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'writing') AS w WHERE JSONExtractString(w, 'ai_summary') = '' FORMAT TSVRaw" |
    while IFS= read -r u; do
      case "$u" in  # url() can't read clickhouse.com's 9.6 KB CSP header yet
        https://clickhouse.com/*) src="https://web.archive.org/web/20260601id_/$u" ;;
        *) src=$u ;;
      esac
      run cloud/enrich-summaries.sql "url=$u" "src=$src" || echo "cloud/enrich.sh: no summary for $u" >&2
    done ;;
  topics) run cloud/enrich-topics.sql ;;
  *) echo "usage: sh cloud/enrich.sh summaries|topics" >&2; exit 2 ;;
esac
