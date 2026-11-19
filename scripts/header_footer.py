#!/usr/bin/env python3
"""Puts scripts/header.html (the top line) and scripts/footer.html (the contact section and footer) between their
markers on every page.

python3 scripts/header_footer.py           rewrite the pages that differ
python3 scripts/header_footer.py --check   only list them (exit 1 if any)
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# (template, start marker, end marker, what the block looked like before the markers)
BLOCKS = [
    ("scripts/header.html", "  <!-- header: edit scripts/header.html, then run scripts/header_footer.py -->\n", "  <!-- /header -->\n",
     re.compile(r'  <div class="top">.*?</div>\n')),
    ("scripts/footer.html", "  <!-- footer: edit scripts/footer.html, then run scripts/header_footer.py -->\n", "  <!-- /footer -->\n",
     re.compile(r'  <section id="contact".*?</footer>\n', re.S)),
]


def main(check):
    pages = [p for p in (ROOT / "public").rglob("*.html") if "wp-content" not in p.parts]
    stale, missing = [], []
    for p in sorted(pages):
        s = new = p.read_text(encoding="utf-8")
        for tpl, start, end, old in BLOCKS:
            want = start + (ROOT / tpl).read_text(encoding="utf-8") + end
            new, n = re.compile(re.escape(start) + r".*?" + re.escape(end), re.S).subn(lambda _: want, new, count=1)
            if not n:
                new, n = old.subn(lambda _: want, new, count=1)
            if not n:
                missing.append((p, tpl))
        if new != s:
            stale.append(p)
            if not check:
                p.write_text(new, encoding="utf-8")
    for p, tpl in missing:
        print(f"no block for {tpl}:", p.relative_to(ROOT), file=sys.stderr)
    verb = "differ" if check else "updated"
    print(f"{len(pages)} pages, {len(stale)} {verb}" + (f", {len(missing)} blocks missing" if missing else ""))
    return 1 if (check and stale) or missing else 0


if __name__ == "__main__":
    sys.exit(main("--check" in sys.argv[1:]))
