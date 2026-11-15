#!/usr/bin/env python3
"""Puts scripts/footer.html (the contact section and footer) between the footer markers on every page.

python3 scripts/footer.py           rewrite the pages that differ
python3 scripts/footer.py --check   only list them (exit 1 if any)
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
START, END = "  <!-- footer: edit scripts/footer.html, then run scripts/footer.py -->\n", "  <!-- /footer -->\n"
BLOCK = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)
OLD = re.compile(r'  <section id="contact".*?</footer>\n', re.S)  # pages from before the markers


def main(check):
    want = START + (ROOT / "scripts/footer.html").read_text(encoding="utf-8") + END
    pages = [p for p in (ROOT / "public").rglob("*.html") if "wp-content" not in p.parts]
    stale, missing = [], []
    for p in sorted(pages):
        s = p.read_text(encoding="utf-8")
        new, n = BLOCK.subn(lambda _: want, s, count=1)
        if not n:
            new, n = OLD.subn(lambda _: want, s, count=1)
        if not n:
            missing.append(p)
        elif new != s:
            stale.append(p)
            if not check:
                p.write_text(new, encoding="utf-8")
    for p in missing:
        print("no footer:", p.relative_to(ROOT), file=sys.stderr)
    verb = "differ" if check else "updated"
    print(f"{len(pages)} pages, {len(stale)} {verb}" + (f", {len(missing)} without a footer" if missing else ""))
    return 1 if (check and stale) or missing else 0


if __name__ == "__main__":
    sys.exit(main("--check" in sys.argv[1:]))
