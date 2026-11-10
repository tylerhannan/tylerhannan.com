#!/bin/sh
# The local half of the comparison (cloud/README.md has the Cloud half). Runs cloud/site.sql end to end on this machine: clickhouse local reads public/ from a local web server
# (instead of https://tylerhannan.com) and embeds through Ollama with qwen3-embedding:0.6b. Then it checks that
# site.pages has one row for everything in the site's JSON, and runs a search and a "nearest posts" query.
#
#   sh cloud/test.sh ["search words"]
#
# Needs: clickhouse (clickhousectl), Ollama with qwen3-embedding:0.6b (MODEL=… to change), python3.
set -eu
cd "$(dirname "$0")/.."
CH=${CLICKHOUSE:-$(command -v clickhouse || echo ~/.local/bin/clickhouse)}
Q=${1:-neon signs at night}
PORT=8765
TMP=$(mktemp -d)
trap 'kill $SERVER 2>/dev/null; rm -rf "$TMP"' EXIT

python3 -m http.server $PORT --bind 127.0.0.1 --directory public >/dev/null 2>&1 & SERVER=$!
sleep 1
# Cloud provides the model; here Ollama does, with the small model of the same family
MODEL=${MODEL:-qwen3-embedding:0.6b}
{ echo "CREATE NAMED COLLECTION IF NOT EXISTS site_embed AS provider = 'openai', endpoint = 'http://localhost:11434/v1/embeddings';"
  sed -e "s|'[^']*' AS base|'http://127.0.0.1:$PORT' AS base|" -e "s|'qwen3-embedding-8b'|'$MODEL'|g" cloud/site.sql
} > "$TMP/site.sql"

ch() { "$CH" local --path "$TMP/db" --ai_function_embedding_default_credentials site_embed "$@"; }
echo "Creating the tables and views, then waiting for the first refresh (embeds every row)…"
# creating the views runs their first refresh; wait for it in the same process, since refresh stats live in
# memory
cat >> "$TMP/site.sql" <<'SQL'
SYSTEM WAIT VIEW site.pages;
SYSTEM WAIT VIEW site.embed;
SELECT view, written_rows AS rows, round(last_success_duration_ms / 1000, 1) AS seconds FROM system.view_refreshes
WHERE database = 'site' ORDER BY view DESC FORMAT PrettyCompactMonoBlock;
SQL
ch --multiquery --queries-file "$TMP/site.sql"

ch --query "SELECT path, kind, title, text FROM site.pages FORMAT JSONEachRow" > "$TMP/pages.jsonl"
python3 - "$TMP/pages.jsonl" <<'EOF'
# Every page, post, talk link, demo and photo in the site's JSON should be one row, and every post should have text
import json, sys
load = lambda f: json.load(open("public/" + f, encoding="utf-8"))
talks = {t.get("url") or "https://www.youtube.com/watch?v=" + t["youtube"] for t in load("talks.json")["talks"]}
want = {"page": 3, "post": len(load("archive/posts.json")["posts"]), "talk": len(talks),
        "demo": len(load("demos.json")["demos"]), "photo": sum(1 for p in load("photos.json")["photos"] if p.get("file"))}
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8")]
got = {k: sum(r["kind"] == k for r in rows) for k in want}
empty = [r["path"] for r in rows if r["kind"] == "post" and not r["text"]]
print("site.pages rows by kind:", got, "" if got == want else f"(expected {want})", f"; posts without text: {len(empty)}")
sys.exit(0 if got == want and not empty else 1)
EOF
ch --query "SELECT count() AS vectors, any(length(v)) AS dims FROM site.vectors FORMAT PrettyCompactMonoBlock"

echo "Second refresh: nothing changed, so nothing should be embedded"
ch --multiquery --query "SYSTEM REFRESH VIEW site.pages; SYSTEM WAIT VIEW site.pages; SYSTEM REFRESH VIEW site.embed; SYSTEM WAIT VIEW site.embed;
  SELECT count() AS vectors FROM site.vectors FORMAT PrettyCompactMonoBlock"

echo "Search: $Q"
ch --param_q "$Q" --query "SELECT * FROM site.search(q = {q:String}) FORMAT PrettyCompactMonoBlock"
echo "Nearest posts to /2012/04/geektool/:"
ch --query "SELECT * FROM site.related(path = '/2012/04/geektool/') FORMAT PrettyCompactMonoBlock"
