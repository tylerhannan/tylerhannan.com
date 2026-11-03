#!/bin/sh
# Runs cloud/site.sql end to end on this machine: clickhouse local reads public/ from a local web server
# (instead of https://tylerhannan.com) and embeds through Ollama. Then it checks that site.pages holds exactly
# the rows scripts/embed.py embeds, and runs a search and a "nearest posts" query.
#
#   sh cloud/test.sh ["search words"]
#
# Needs: clickhouse (clickhousectl), Ollama with embeddinggemma, python3.
set -eu
cd "$(dirname "$0")/.."
CH=${CLICKHOUSE:-$(command -v clickhouse || echo ~/.local/bin/clickhouse)}
Q=${1:-neon signs at night}
PORT=8765
TMP=$(mktemp -d)
trap 'kill $SERVER 2>/dev/null; rm -rf "$TMP"' EXIT

python3 -m http.server $PORT --bind 127.0.0.1 --directory public >/dev/null 2>&1 & SERVER=$!
sleep 1
sed "s|'https://tylerhannan.com' AS base|'http://127.0.0.1:$PORT' AS base|" cloud/site.sql > "$TMP/site.sql"

ch() { "$CH" local --path "$TMP/db" "$@"; }
echo "Creating the tables and views, then waiting for the first refresh (embeds every row)…"
ch --multiquery --queries-file "$TMP/site.sql"
ch --multiquery --query "SYSTEM REFRESH VIEW site.pages; SYSTEM WAIT VIEW site.pages; SYSTEM REFRESH VIEW site.embed; SYSTEM WAIT VIEW site.embed;"

ch --query "SELECT path, kind, title, text FROM site.pages FORMAT JSONEachRow" > "$TMP/pages.jsonl"
python3 - "$TMP/pages.jsonl" <<'EOF'
import json, sys
sys.path.insert(0, "scripts")
from embed import docs
want = {d["path"]: d for d in docs()}
got = {r["path"]: r for r in map(json.loads, open(sys.argv[1], encoding="utf-8"))}
bad = [p for p in want.keys() | got.keys() if want.get(p) != got.get(p)]
print(f"site.pages: {len(got)} rows; embed.py: {len(want)} rows; different: {len(bad)}", *bad[:5], sep="\n  ")
sys.exit(1 if bad else 0)
EOF
ch --query "SELECT count() AS vectors, any(length(v)) AS dims FROM site.vectors FORMAT PrettyCompactMonoBlock"

echo "Second refresh: nothing changed, so nothing should be embedded"
ch --multiquery --query "SYSTEM REFRESH VIEW site.pages; SYSTEM WAIT VIEW site.pages; SYSTEM REFRESH VIEW site.embed; SYSTEM WAIT VIEW site.embed;
  SELECT count() AS vectors FROM site.vectors FORMAT PrettyCompactMonoBlock"

echo "Search: $Q"
ch --param_q "$Q" --query "SELECT * FROM site.search(q = {q:String}) FORMAT PrettyCompactMonoBlock"
echo "Nearest posts to /2012/04/geektool/ (the static page has these from 384 Int8 dims; these use 768 Float32):"
ch --query "SELECT * FROM site.related(path = '/2012/04/geektool/') FORMAT PrettyCompactMonoBlock"
python3 -c "import json; [print('  ', r['similarity'], r['title']) for r in json.load(open('public/archive/related.json'))['/2012/04/geektool/']]"
