#!/usr/bin/env python3
"""Embed every page on the site with ClickHouse's aiEmbed, for the semantic queries on the 404 and post pages.

Usage:
    python3 scripts/embed.py

Needs, on this machine:
  - Ollama running, with the model pulled:  ollama pull embeddinggemma
  - clickhouse on PATH (clickhousectl local use latest), or CLICKHOUSE=/path/to/clickhouse

What it does:
  - collects the same rows as the `pages` table in public/run.js (home, photos, archive, every post, talk and demo)
    plus every photo (from its title, alt text and place),
    with a post's text taken from its HTML
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
from import_wordpress import PUBLIC, excerpt, related_section  # noqa: E402

MODEL = "embeddinggemma"
DIMS = 384
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434") + "/v1/embeddings"
RELATED = 5


def describe(page):
    """A page's <meta name="description">."""
    m = re.search(r'<meta name="description" content="([^"]*)"', (PUBLIC / page / "index.html").read_text(encoding="utf-8"))
    return html.unescape(m.group(1)) if m else ""


def post_text(path):
    """A post's body as plain text, from the page the importer wrote."""
    page = (PUBLIC / unquote(path.strip("/")) / "index.html").read_text(encoding="utf-8")
    m = re.search(r'<div class="content">(.*?)\n    </div>\n    <p class="note">', page, re.S)
    return excerpt(m.group(1) if m else "", 2000)


def docs():
    """The rows of run.js's `pages` table, keyed the same way (path before decoding; a talk's url; a demo's repo)."""
    posts = json.loads((PUBLIC / "archive/posts.json").read_text(encoding="utf-8"))["posts"]
    talks = json.loads((PUBLIC / "talks.json").read_text(encoding="utf-8"))["talks"]
    demos = json.loads((PUBLIC / "demos.json").read_text(encoding="utf-8"))["demos"]
    photos = json.loads((PUBLIC / "photos.json").read_text(encoding="utf-8"))["photos"]
    out = [{"path": "/", "kind": "page", "title": "Home", "text": describe("")},
           {"path": "/photos/", "kind": "page", "title": "Photos", "text": describe("photos")},
           {"path": "/archive/", "kind": "page", "title": "Writing archive", "text": describe("archive")}]
    out += [{"path": p["path"], "kind": "post", "title": p["title"], "text": post_text(p["path"])} for p in posts]
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
SQL = f"""
CREATE NAMED COLLECTION tylerhannan_embed AS provider = 'openai', endpoint = '{OLLAMA}';

CREATE TABLE docs ENGINE = Memory AS
SELECT path, kind, title,
       arraySlice(aiEmbed('title: ' || title || ' | text: ' || text, '{MODEL}', map('credentials', 'tylerhannan_embed')), 1, {DIMS}) AS v
FROM file('docs.jsonl', JSONEachRow, 'path String, kind String, title String, text String');

CREATE TABLE vectors ENGINE = Memory AS
SELECT path, kind, title, arrayMap(x -> toInt8(round(x * 127 / arrayMax(arrayMap(abs, v)))), v) AS q
FROM docs;

SELECT path, q FROM vectors INTO OUTFILE 'vectors.jsonl' FORMAT JSONEachRow;

-- each post page's query, for every post at once: same rounding and order as the query shown on the page
SELECT src AS path, arraySlice(arraySort(x -> (-x.1, x.3), groupArray((similarity, title, dst))), 1, {RELATED}) AS related
FROM (
    SELECT a.path AS src, b.title AS title, b.path AS dst,
           round(1 - cosineDistance(arrayMap(toFloat32, b.q), arrayMap(toFloat32, a.q)), 2) AS similarity
    FROM vectors AS a CROSS JOIN vectors AS b
    WHERE a.kind = 'post' AND b.kind = 'post' AND a.path != b.path
)
GROUP BY src
INTO OUTFILE 'related.jsonl' FORMAT JSONEachRow;
"""


def main():
    ch = os.environ.get("CLICKHOUSE") or shutil.which("clickhouse")
    if not ch:
        sys.exit("clickhouse not found: install it with clickhousectl (clickhousectl local use latest) or set CLICKHOUSE")
    rows = docs()
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "docs.jsonl").write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in rows), encoding="utf-8")
        print(f"Embedding {len(rows)} pages with {MODEL} via Ollama…", flush=True)
        # its own --path: clickhouse local otherwise keeps tables and named collections between runs
        r = subprocess.run([ch, "local", "--path", str(tmp / "ch"), "--multiquery", SQL], cwd=tmp, capture_output=True, text=True)
        if r.returncode:
            sys.exit(r.stderr.strip() or f"clickhouse local exited with {r.returncode}")
        vectors = [json.loads(line) for line in (tmp / "vectors.jsonl").read_text(encoding="utf-8").splitlines()]
        related = [json.loads(line) for line in (tmp / "related.jsonl").read_text(encoding="utf-8").splitlines()]

    b64 = lambda q: base64.b64encode(bytes(x & 0xFF for x in q)).decode()
    (PUBLIC / "embeddings.json").write_text(json.dumps(
        {"model": MODEL, "dims": DIMS, "vectors": {v["path"]: b64(v["q"]) for v in vectors}},
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
