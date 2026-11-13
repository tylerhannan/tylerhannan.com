#!/usr/bin/env python3
"""Embed every page, talk, demo, photo and post with aiEmbed in clickhouse local, through Ollama.

    python3 scripts/embed.py

Needs Ollama with embeddinggemma pulled, and clickhouse on PATH (or CLICKHOUSE=/path/to/clickhouse).
Writes public/embeddings.json (first 384 of 768 dims, Int8, base64; 128 missed the neon photos, 768
doesn't fit in play's 256 KB) and each post's nearest posts. Re-run after adding things.
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

PUBLIC = Path(__file__).resolve().parent.parent / "public"

MODEL = "embeddinggemma"
DIMS = 384
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434") + "/v1/embeddings"
RELATED = 5


def excerpt(body, limit=155):
    """First words of the post as plain text, for search results and link previews."""
    text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", body))).strip()
    text = re.sub(r" ([.,;:!?)])", r"\1", text)
    text = re.sub(r"\[image no longer available[^\]]*\]|\[video no longer available\]", "", text).strip()
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0].rstrip(",.;:") + "…"


def related_section(path, items):
    """The post page's "nearest posts" query and its result (from scripts/embed.py), runnable like the home page's."""
    e = lambda v: html.escape(str(v), quote=True)
    p = e("'" + path.replace("\\", "\\\\").replace("'", "\\'") + "'")
    rows = "".join(f'<tr><td class="d">{i["similarity"]:.2f}</td><td><a href="{e(i["path"])}">{e(i["title"])}</a></td>'
                   f'<td class="e">{e(unquote(i["path"]))}</td></tr>' for i in items)
    return f"""  <!-- related -->
  <section aria-labelledby="related-h">
    <p class="label" id="related-h">Nearest posts</p>
    <div class="query" data-run><span class="p">:) </span><span class="kw">WITH</span>
     (<span class="kw">SELECT</span> embedding <span class="kw">FROM</span> posts <span class="kw">WHERE</span> path = <span class="s">{p}</span>) <span class="kw">AS</span> this_post
   <span class="kw">SELECT</span> <span class="kw">round</span>(<span class="n">1</span> - <span class="kw">cosineDistance</span>(embedding, this_post), <span class="n">2</span>) <span class="kw">AS</span> similarity, title, path
   <span class="kw">FROM</span> posts
   <span class="kw">WHERE</span> path != <span class="s">{p}</span>
   <span class="kw">ORDER BY</span> similarity <span class="kw">DESC</span>, path
   <span class="kw">LIMIT</span> <span class="n">{len(items)}</span>;</div>
    <div class="tbl near"><table>
      <thead><tr><th>similarity</th><th>title</th><th>path</th></tr></thead>
      <tbody>{rows}</tbody>
    </table></div>
    <p class="foot">{len(items)} rows in set. Each post's embedding is from EmbeddingGemma, made with ClickHouse's aiEmbed.</p>
  </section>
  <script src="/run.js" defer></script>
  <!-- /related -->
"""

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
    """The rows of run.js's `pages` table, keyed the same way (path before decoding; a talk's url; a demo's repo; a post elsewhere's url)."""
    posts = json.loads((PUBLIC / "archive/posts.json").read_text(encoding="utf-8"))["posts"]
    talks = json.loads((PUBLIC / "talks.json").read_text(encoding="utf-8"))["talks"]
    demos = json.loads((PUBLIC / "demos.json").read_text(encoding="utf-8"))["demos"]
    photos = json.loads((PUBLIC / "photos.json").read_text(encoding="utf-8"))["photos"]
    writing = json.loads((PUBLIC / "writing.json").read_text(encoding="utf-8"))["writing"]
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
    for w in writing:  # posts elsewhere: only the title is ours to embed, keyed by the post's url
        text = " · ".join(x for x in ("A post on " + w["venue"], ("with " + w["coauthors"]) if w.get("coauthors") else None) if x)
        out.append({"path": w["url"], "kind": "writing", "title": w["title"], "text": text})
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


# EmbeddingGemma's document prompt, then the first DIMS dims scaled to ±127 (cosine ignores scale)
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
        # --tmp: clickhouse local keeps tables between runs, so CREATE would fail the second time
        r = subprocess.run([ch, "local", "--tmp", "--multiquery", SQL], cwd=tmp, capture_output=True, text=True)
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

    pattern = re.compile(r"  <!-- related -->.*?<!-- /related -->\n|(?=  <section id=\"contact\")", re.S)
    for path, items in rel.items():
        f = PUBLIC / unquote(path.strip("/")) / "index.html"
        f.write_text(pattern.sub(lambda m: related_section(path, items), f.read_text(encoding="utf-8"), count=1), encoding="utf-8")
    print(f"Wrote public/embeddings.json ({len(vectors)} vectors, {DIMS} dims) and nearest posts for {len(rel)} posts.")


if __name__ == "__main__":
    main()
