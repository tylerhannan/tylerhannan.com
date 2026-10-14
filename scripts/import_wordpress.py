#!/usr/bin/env python3
"""Turn a WordPress SQL export into static pages for tylerhannan.com.

Usage:
    python3 scripts/import_wordpress.py backup/wordpress.sql

What it does:
  - reads published posts from the *_posts table (any table prefix)
  - reads the site's permalink structure from *_options, so each post keeps
    its old URL (e.g. /2012/05/my-post/) and old inbound links keep working
  - writes public/<permalink>/index.html for every post
  - writes public/archive/posts.json, which the archive page lists
  - rewrites links to the old domain's wp-content/uploads to /wp-content/uploads,
    so copy the old public_html/wp-content/uploads folder to public/wp-content/uploads

Only the Python standard library is used. Re-running it is safe; it overwrites.
"""
import html
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote, unquote

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

# The blog went quiet after 2012. Everything published later was spam injected
# into the hacked WordPress install, so skip it.
LAST_REAL_YEAR = "2012"


# ---------- SQL parsing ----------

def parse_values(s, i):
    """Parse a run of (...),(...); tuples starting at s[i]. Returns (rows, end)."""
    rows, n = [], len(s)
    while i < n:
        while i < n and s[i] in " \t\r\n,":
            i += 1
        if i >= n or s[i] == ";":
            return rows, i + 1
        if s[i] != "(":
            raise ValueError(f"unexpected {s[i]!r} at {i}")
        i += 1
        row = []
        while True:
            while s[i] in " \t\r\n":
                i += 1
            if s[i] == "'":
                i += 1
                buf = []
                while True:
                    c = s[i]
                    if c == "\\":
                        nxt = s[i + 1]
                        buf.append({"n": "\n", "r": "\r", "t": "\t", "0": "\0", "Z": "\x1a"}.get(nxt, nxt))
                        i += 2
                    elif c == "'":
                        if s[i + 1] == "'":
                            buf.append("'")
                            i += 2
                        else:
                            i += 1
                            break
                    else:
                        buf.append(c)
                        i += 1
                row.append("".join(buf))
            else:
                j = i
                while s[j] not in ",)":
                    j += 1
                tok = s[i:j].strip()
                row.append(None if tok.upper() == "NULL" else tok)
                i = j
            while s[i] in " \t\r\n":
                i += 1
            if s[i] == ",":
                i += 1
                continue
            if s[i] == ")":
                i += 1
                break
        rows.append(row)
    return rows, i


def table_columns(sql, table):
    m = re.search(r"CREATE TABLE `%s` \((.*?)\n\)" % re.escape(table), sql, re.S)
    if not m:
        return None
    return re.findall(r"^\s*`([^`]+)`", m.group(1), re.M)


def read_table(sql, suffix):
    """Return (table_name, list of dict rows) for the first table ending in suffix."""
    names = re.findall(r"INSERT INTO `([A-Za-z0-9_]*%s)`" % re.escape(suffix), sql)
    if not names:
        return None, []
    table = names[0]
    cols = table_columns(sql, table)
    out = []
    pat = re.compile(r"INSERT INTO `%s`\s*(\(([^)]*)\))?\s*VALUES\s*" % re.escape(table))
    for m in pat.finditer(sql):
        these = [c.strip(" `") for c in m.group(2).split(",")] if m.group(2) else cols
        if not these:
            sys.exit(f"Couldn't find column names for {table}.")
        rows, _ = parse_values(sql, m.end())
        out += [dict(zip(these, r)) for r in rows]
    return table, out


# ---------- content ----------

BLOCK = r"(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|math|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary|iframe|script)"


def autop(text):
    """A small version of WordPress's wpautop: blank lines become paragraphs."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return ""
    pres = []

    def keep(m):
        pres.append(m.group(0))
        return f"\x00PRE{len(pres) - 1}\x00"

    text = re.sub(r"<pre[\s\S]*?</pre>", keep, text, flags=re.I)
    out = []
    for chunk in re.split(r"\n\s*\n", text):
        chunk = chunk.strip()
        if not chunk:
            continue
        if chunk.startswith("\x00PRE") or re.match(r"</?%s[\s/>]" % BLOCK, chunk, re.I):
            out.append(chunk)
        else:
            out.append("<p>" + chunk.replace("\n", "<br>\n") + "</p>")
    html_out = "\n".join(out)
    return re.sub(r"\x00PRE(\d+)\x00", lambda m: pres[int(m.group(1))], html_out)


# SyntaxHighlighter shortcodes: [sourcecode language="bash"]...[/sourcecode], [php]...[/php], etc.
CODE_TAGS = "sourcecode|code|bash|shell|php|java|csharp|xml|html|js|javascript|python|sql|css|ruby|perl|plain|text"


def code_block(m):
    code = html.unescape(m.group(2)).strip("\r\n")
    return "<pre><code>" + html.escape(code, quote=False) + "</code></pre>"


# Link roundups copied from feeds kept links relative to the source site, which 404 here.
RELATIVE_FIXUPS = {
    "/archives/2009/12/18/cloud-exchange-aws-spot-prices-visualized/": "http://www.datacenterknowledge.com/archives/2009/12/18/cloud-exchange-aws-spot-prices-visualized/",
    "/ignition-strategies-how-to-launch-a-platform-business": "http://pymnts.com/ignition-strategies-how-to-launch-a-platform-business",
}


def clean(content, old_hosts):
    content = re.sub(r"<!--\s*/?wp:[\s\S]*?-->", "", content)  # block editor comments
    content = re.sub(r"\[(%s)(?:\s[^\]]*)?\]([\s\S]*?)\[/\1\]" % CODE_TAGS, code_block, content)
    content = re.sub(r"\[caption[^\]]*\]([\s\S]*?)\[/caption\]", r"<figure>\1</figure>", content)
    content = re.sub(r"\[embed\]([\s\S]*?)\[/embed\]", r'<p><a href="\1">\1</a></p>', content)
    content = re.sub(r"\[/?(gallery|audio|video)[^\]]*\]", "", content)
    content = re.sub(r"<script[\s\S]*?</script>", "", content, flags=re.I)  # dead third-party widgets
    for host in old_hosts:
        content = re.sub(r"https?://(www\.)?%s/wp-content/" % re.escape(host), "/wp-content/", content)
    content = re.sub(r'href="www\.', 'href="http://www.', content)  # scheme-less links
    for rel, absolute in RELATIVE_FIXUPS.items():
        content = content.replace('href="%s' % rel, 'href="%s' % absolute)
    return autop(content)


def permalink(structure, post):
    d = post["post_date"]  # 'YYYY-MM-DD HH:MM:SS'
    if not structure or "%" not in structure:
        return f"/archive/{post['ID']}-{post['post_name'] or 'post'}/"
    p = structure
    for tag, val in {
        "%year%": d[0:4], "%monthnum%": d[5:7], "%day%": d[8:10],
        "%hour%": d[11:13], "%minute%": d[14:16], "%second%": d[17:19],
        "%postname%": post["post_name"] or str(post["ID"]), "%post_id%": str(post["ID"]),
        "%category%": "uncategorized", "%author%": "tyler",
    }.items():
        p = p.replace(tag, val)
    p = "/" + p.strip("/") + "/"
    return quote(unquote(p.replace("//", "/")), safe="/")  # canonical %XX (upper case), as the host redirects to


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Tyler Hannan</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=JetBrains+Mono:wght@400;500&family=Instrument+Sans:wght@400;500&display=swap">
<link rel="stylesheet" href="/style.css">
<script src="/theme.js"></script>
</head>
<body>
<div class="wrap">
  <div class="top"><a class="back" href="/archive/">← writing archive</a><button type="button" class="theme" aria-label="Switch to light mode">☀ light</button></div>
  <article>
    <h1>{title}</h1>
    <p class="meta">{date}</p>
    <div class="content">
{content}
    </div>
    <p class="note">Archived from the old tylerhannan.com blog. Originally published {date}.</p>
  </article>
  <footer><span>tylerhannan.com</span><a href="/">home</a></footer>
</div>
</body>
</html>
"""


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sql = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")

    _, options = read_table(sql, "_options")
    opt = {o.get("option_name"): o.get("option_value") for o in options}
    structure = opt.get("permalink_structure") or ""
    hosts = {"tylerhannan.com"}
    for key in ("siteurl", "home"):
        if opt.get(key):
            hosts.add(re.sub(r"^https?://(www\.)?", "", opt[key]).rstrip("/"))

    table, posts = read_table(sql, "_posts")
    if not table:
        sys.exit("No *_posts table found in that file. Is it the WordPress database export?")
    posts = [p for p in posts if p.get("post_type") == "post" and p.get("post_status") == "publish"]
    spam = [p for p in posts if p["post_date"][:4] > LAST_REAL_YEAR]
    posts = [p for p in posts if p["post_date"][:4] <= LAST_REAL_YEAR]

    index = []
    for p in posts:
        path = permalink(structure, p)
        title = html.unescape(p.get("post_title") or "Untitled")
        date = p["post_date"][:10]
        # WordPress stores non-ASCII slugs percent-encoded ("%e2%80%9c"). The host decodes request
        # paths before matching files, so folders need the real characters; links stay encoded.
        out = PUBLIC / unquote(path.strip("/")) / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(PAGE.format(title=html.escape(title), date=date,
                                   content=clean(p.get("post_content") or "", hosts)), encoding="utf-8")
        index.append({"date": date, "title": title, "path": path})

    index.sort(key=lambda x: x["date"], reverse=True)
    (PUBLIC / "archive" / "posts.json").write_text(json.dumps({"posts": index}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Imported {len(index)} posts from {table}.")
    if spam:
        print(f"Skipped {len(spam)} posts after {LAST_REAL_YEAR} as spam: " + ", ".join(p["post_name"] or str(p["ID"]) for p in spam))
    print(f"Permalink structure: {structure or '(default ?p=ID; posts placed under /archive/)'}")
    if "%category%" in structure:
        print("Note: %category% in permalinks was written as 'uncategorized'. Old category URLs may not match.")
    uploads = PUBLIC / "wp-content" / "uploads"
    if not uploads.exists():
        print("Images: copy the old public_html/wp-content/uploads folder to public/wp-content/uploads.")


if __name__ == "__main__":
    main()
