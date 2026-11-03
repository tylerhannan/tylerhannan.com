#!/usr/bin/env python3
"""Embed every page on the site with ClickHouse's aiEmbed, for the semantic queries on the 404 and post pages.

Usage:
    python3 scripts/embed.py            # clickhouse local + Ollama on this machine
    python3 scripts/embed.py --cloud    # the same SQL on a ClickHouse Cloud service (AI functions, private preview)
    python3 scripts/embed.py --check    # Cloud smoke test: embeds a few pages there, compares with embeddings.json

Needs, on this machine:
  - clickhouse on PATH (clickhousectl local use latest), or CLICKHOUSE=/path/to/clickhouse
  - local: Ollama running, with the model pulled:  ollama pull embeddinggemma
  - --cloud / --check: CLICKHOUSE_HOST, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD for the service (read by
    clickhouse client itself, so the password never appears on a command line), and CLOUDFLARE_ACCOUNT_ID +
    CLOUDFLARE_API_TOKEN (Workers AI read). Cloud can't reach Ollama on this laptop, so the service calls the same
    EmbeddingGemma on Workers AI's OpenAI-compatible endpoint that src/worker.js uses for queries. The token goes
    into a named collection for the run only and is dropped at the end. Tables stay in the `tylerhannan` database.

What it does:
  - collects the same rows as the `pages` table in public/run.js (home, photos, archive, every post, talk and demo)
    plus every photo (from its title, alt text and place),
    with a post's text from public/archive/text.json (written by the importer)
  - runs aiEmbed(…, 'embeddinggemma') over them in clickhouse local, through Ollama's OpenAI-compatible endpoint
  - keeps the first 384 of EmbeddingGemma's 768 dimensions (it's trained so that a prefix still works) and
    scales each to Int8, then writes public/embeddings.json: {path: base64 of the 384 bytes}. 128 was too lossy
    for one-word searches ("neon" missed the neon photos); 768 would push the pages table past play's 256 KB query limit
  - runs the "nearest posts" query from each post page in clickhouse local, on exactly those Int8 vectors, writes
    public/archive/related.json, and puts the results into every post page (the importer does too, on re-import)

The 404 page embeds the missed URL live with the same model on Cloudflare Workers AI (src/worker.js), using
the same truncation and scaling, so the two sets of vectors are comparable.

Re-run it after adding posts or talks; a page without a vector is all zeros and sorts last. Stdlib only.
"""
import base64
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_wordpress import PUBLIC, related_section  # noqa: E402

MODEL = "embeddinggemma"
DIMS = 384
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434") + "/v1/embeddings"
RELATED = 5


def describe(page):
    """A page's <meta name="description">."""
    m = re.search(r'<meta name="description" content="([^"]*)"', (PUBLIC / page / "index.html").read_text(encoding="utf-8"))
    return html.unescape(m.group(1)) if m else ""




def docs():
    """The rows of run.js's `pages` table, keyed the same way (path before decoding; a talk's url; a demo's repo)."""
    posts = json.loads((PUBLIC / "archive/posts.json").read_text(encoding="utf-8"))["posts"]
    talks = json.loads((PUBLIC / "talks.json").read_text(encoding="utf-8"))["talks"]
    demos = json.loads((PUBLIC / "demos.json").read_text(encoding="utf-8"))["demos"]
    photos = json.loads((PUBLIC / "photos.json").read_text(encoding="utf-8"))["photos"]
    text = {p["path"]: p["text"] for p in json.loads((PUBLIC / "archive/text.json").read_text(encoding="utf-8"))["posts"]}
    out = [{"path": "/", "kind": "page", "title": "Home", "text": describe("")},
           {"path": "/photos/", "kind": "page", "title": "Photos", "text": describe("photos")},
           {"path": "/archive/", "kind": "page", "title": "Writing archive", "text": describe("archive")}]
    out += [{"path": p["path"], "kind": "post", "title": p["title"], "text": text[p["path"]]} for p in posts]
    for t in talks:
        path = t.get("url") or "https://www.youtube.com/watch?v=" + t["youtube"]
        text = " · ".join(x for x in (t["event"], t.get("location"), t.get("note")) if x)
        out.append({"path": path, "kind": "talk", "title": t["title"], "text": text})
    for d in demos:
        text = " · ".join(x for x in ("A demo: " + d["about"], d.get("event")) if x)
        out.append({"path": d["repo"], "kind": "demo", "title": d["name"], "text": text})
    for p in photos:  # not pages, but the photos table gets vectors too, keyed by the photo's URL
        if p.get("file"):
            text = " · ".join(x for x in ("A photo: " + (p.get("alt") or p["title"]), p.get("place")) if x)
            out.append({"path": "/photos/" + p["file"], "kind": "photo", "title": p["title"], "text": text})
    seen, uniq = set(), []
    for d in out:  # two talks can share a playlist link; they share a vector too
        if d["path"] not in seen:
            seen.add(d["path"])
            uniq.append(d)
    return uniq


# EmbeddingGemma's document prompt (the query side, in src/worker.js, is "task: search result | query: …").
# Then: the first DIMS dimensions, scaled so the largest is ±127. Cosine distance ignores the scale.
# {db} is a table prefix, {engine} the table engine, {src} where the text rows come from, {model} the model's name
# at that provider. Local and Cloud run the same statements.
EMBED = """
CREATE {replace}TABLE {db}docs ENGINE = {engine} AS
SELECT path, kind, title,
       arraySlice(aiEmbed('title: ' || title || ' | text: ' || text, '{model}', map('credentials', 'tylerhannan_embed')), 1, {dims}) AS v
FROM {src};

CREATE {replace}TABLE {db}vectors ENGINE = {engine} AS
SELECT path, kind, title, arrayMap(x -> toInt8(round(x * 127 / arrayMax(arrayMap(abs, v)))), v) AS q
FROM {db}docs;
"""

OUTPUTS = """
SELECT path, q FROM {db}vectors INTO OUTFILE 'vectors.jsonl' FORMAT JSONEachRow;

-- each post page's query, for every post at once: same rounding and order as the query shown on the page
SELECT src AS path, arraySlice(arraySort(x -> (-x.1, x.3), groupArray((similarity, title, dst))), 1, {related}) AS related
FROM (
    SELECT a.path AS src, b.title AS title, b.path AS dst,
           round(1 - cosineDistance(arrayMap(toFloat32, b.q), arrayMap(toFloat32, a.q)), 2) AS similarity
    FROM {db}vectors AS a CROSS JOIN {db}vectors AS b
    WHERE a.kind = 'post' AND b.kind = 'post' AND a.path != b.path
)
GROUP BY src
INTO OUTFILE 'related.jsonl' FORMAT JSONEachRow;
"""

TEXT = "path String, kind String, title String, text String"


def sq(s):
    """A ClickHouse string literal."""
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def local_sql():
    return (f"CREATE NAMED COLLECTION tylerhannan_embed AS provider = 'openai', endpoint = '{OLLAMA}';\n"
            + EMBED.format(replace="", db="", engine="Memory", model=MODEL, dims=DIMS,
                           src=f"file('docs.jsonl', JSONEachRow, '{TEXT}')")
            + OUTPUTS.format(db="", related=RELATED))


# Cloud: the same statements, against the Workers AI model, in MergeTree tables in their own database
CLOUD_MODEL = "@cf/google/embeddinggemma-300m"
CLOUD_DB = "tylerhannan"


def cloud_env():
    missing = [k for k in ("CLICKHOUSE_HOST", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD",
                           "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN") if not os.environ.get(k)]
    if missing:
        sys.exit("--cloud needs " + ", ".join(missing))


def collection_sql():
    endpoint = f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/ai/v1/embeddings"
    return ("DROP NAMED COLLECTION IF EXISTS tylerhannan_embed;\n"
            f"CREATE NAMED COLLECTION tylerhannan_embed AS provider = 'openai', endpoint = {sq(endpoint)}, "
            f"api_key = {sq(os.environ['CLOUDFLARE_API_TOKEN'])};\n")


def cloud(ch, tmp, sql, stdin=None):
    """Runs statements on the Cloud service; SQL goes in on stdin so the API token stays off the command line."""
    args = ["--query", sql] if stdin is not None else ["--multiquery"]  # an INSERT's rows come in on stdin
    r = subprocess.run([ch, "client", "--secure"] + args,
                       input=stdin if stdin is not None else sql, cwd=tmp, capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stderr.strip() or f"clickhouse client exited with {r.returncode}")
    return r.stdout


def run_cloud(ch, tmp, rows):
    db = CLOUD_DB + "."
    cloud(ch, tmp, f"CREATE DATABASE IF NOT EXISTS {CLOUD_DB};\n"
                   f"CREATE OR REPLACE TABLE {db}docs_text ({TEXT}) ENGINE = MergeTree ORDER BY path;")
    cloud(ch, tmp, f"INSERT INTO {db}docs_text FORMAT JSONEachRow", stdin=(tmp / "docs.jsonl").read_text(encoding="utf-8"))
    try:
        cloud(ch, tmp, collection_sql()
              + EMBED.format(replace="OR REPLACE ", db=db, engine="MergeTree ORDER BY path", model=CLOUD_MODEL,
                             dims=DIMS, src=f"{db}docs_text")
              + OUTPUTS.format(db=db, related=RELATED))
    finally:
        cloud(ch, tmp, "DROP NAMED COLLECTION IF EXISTS tylerhannan_embed;")


def check_cloud(ch, rows):
    """Embeds a handful of pages on Cloud and compares each with its vector in embeddings.json (Ollama's)."""
    stored = json.loads((PUBLIC / "embeddings.json").read_text(encoding="utf-8"))["vectors"]
    sample = [d for d in rows if d["path"] in stored][::max(1, len(rows) // 5)][:5]
    unpack = lambda b: [x - 256 if x > 127 else x for x in base64.b64decode(b)]
    values = ", ".join(f"({sq(d['path'])}, {sq(d['title'])}, {sq(d['text'])}, "
                       f"[{','.join(map(str, unpack(stored[d['path']])))}])" for d in sample)
    sql = (collection_sql()
           + "SELECT version(), (SELECT count() FROM system.functions WHERE name = 'aiEmbed') FORMAT TSV;\n"
           + f"SELECT path, round(1 - cosineDistance(arraySlice(aiEmbed('title: ' || title || ' | text: ' || text, "
             f"'{CLOUD_MODEL}', map('credentials', 'tylerhannan_embed')), 1, {DIMS}), arrayMap(toFloat32, q)), 4) "
             f"FROM values('path String, title String, text String, q Array(Int8)', {values}) FORMAT TSV;\n")
    with tempfile.TemporaryDirectory() as tmp:
        try:
            out = cloud(ch, Path(tmp), sql)
        finally:
            cloud(ch, Path(tmp), "DROP NAMED COLLECTION IF EXISTS tylerhannan_embed;")
    lines = out.strip().splitlines()
    print("Cloud service:", lines[0].replace("\t", ", aiEmbed present: "))
    print("Similarity of Cloud (Workers AI) vs local (Ollama) vectors, 1.0 = identical:")
    for line in lines[1:]:
        print("  " + line.replace("\t", "  "))


def main():
    ch = os.environ.get("CLICKHOUSE") or shutil.which("clickhouse")
    if not ch:
        sys.exit("clickhouse not found: install it with clickhousectl (clickhousectl local use latest) or set CLICKHOUSE")
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in ("", "--cloud", "--check"):
        sys.exit(__doc__)
    rows = docs()
    if mode:
        cloud_env()
    if mode == "--check":
        return check_cloud(ch, rows)
    model = CLOUD_MODEL if mode else MODEL
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "docs.jsonl").write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in rows), encoding="utf-8")
        if mode == "--cloud":
            print(f"Embedding {len(rows)} pages with {CLOUD_MODEL} on ClickHouse Cloud ({os.environ['CLICKHOUSE_HOST']})…", flush=True)
            run_cloud(ch, tmp, rows)
        else:
            print(f"Embedding {len(rows)} pages with {MODEL} via Ollama…", flush=True)
            # --tmp: by default clickhouse local keeps its tables and named collections between runs (by design, in
            # ~/Library/Application Support/clickhouse-local), so CREATE would fail on the second run
            r = subprocess.run([ch, "local", "--tmp", "--multiquery", local_sql()], cwd=tmp, capture_output=True, text=True)
            if r.returncode:
                sys.exit(r.stderr.strip() or f"clickhouse local exited with {r.returncode}")
        vectors = [json.loads(line) for line in (tmp / "vectors.jsonl").read_text(encoding="utf-8").splitlines()]
        order = {d["path"]: i for i, d in enumerate(rows)}  # MergeTree returns rows by path; keep the file's order
        vectors.sort(key=lambda v: order[v["path"]])
        related = [json.loads(line) for line in (tmp / "related.jsonl").read_text(encoding="utf-8").splitlines()]

    b64 = lambda q: base64.b64encode(bytes(x & 0xFF for x in q)).decode()
    (PUBLIC / "embeddings.json").write_text(json.dumps(
        {"model": model, "dims": DIMS, "vectors": {v["path"]: b64(v["q"]) for v in vectors}},
        indent=0, ensure_ascii=False) + "\n", encoding="utf-8")

    rel = {r["path"]: [{"similarity": s, "title": t, "path": p} for s, t, p in r["related"]]
           for r in sorted(related, key=lambda r: r["path"])}
    (PUBLIC / "archive/related.json").write_text(json.dumps(rel, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    pattern = re.compile(r"  <!-- related -->.*?<!-- /related -->\n|(?=  <section id=\"contact\")", re.S)
    for path, items in rel.items():
        f = PUBLIC / unquote(path.strip("/")) / "index.html"
        f.write_text(pattern.sub(lambda m: related_section(path, items), f.read_text(encoding="utf-8"), count=1), encoding="utf-8")
    print(f"Wrote public/embeddings.json ({len(vectors)} vectors, {DIMS} dims) and nearest posts for {len(rel)} posts.")


if __name__ == "__main__":
    main()
