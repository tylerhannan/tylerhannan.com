# tylerhannan.com

Static site, no build step. Everything served lives in `public/`. Hosted on Cloudflare Workers (`wrangler.jsonc`); every push to `main` deploys.

Preview locally (pages fetch JSON, so opening the files directly won't work):

```
cd public && python3 -m http.server 8000
```

## Adding photos

Export from Lightroom with:

| Setting | Value |
|---|---|
| Format | JPEG, quality 90+ |
| Color space | sRGB |
| Size | Long edge 2000 px or larger (don't enlarge) |
| Metadata | Copyright only, **Remove Location Info** checked |

Then add each one:

```
scripts/add-photo.sh ~/Pictures/Export/IMG_1234.jpg "Title" "Place" "YYYY-MM"
```

The script shrinks the long edge to 2000 px (smaller photos stay as they are), makes a 600 px thumbnail for the grid, strips the metadata, saves them as `public/photos/<title>.jpg` and `public/photos/thumbs/<title>.jpg`, and adds the photo to the top of `public/photos.json`. The date is required, as `YYYY-MM`. Commit and push to publish.

- `scripts/strip_metadata.py` keeps only the pixels, the colour profile and the orientation. GPS, place names (EXIF, XMP and IPTC), camera and lens serial numbers, owner and copyright all go, so fill in `camera` in `photos.json` if you want it shown. Ticking "Remove Location Info" in Lightroom is still a good habit.
- The grid crops every photo to a 4:3 landscape box. The full-size viewer shows the whole photo. If the crop cuts off the subject, add `"focus": "top"` (or `bottom`, `left`, `right`) to that photo in `photos.json`.
- Titles become filenames; the script refuses a title whose file already exists.
- Optional fields in `photos.json`: `camera` (shown in the viewer caption) and `alt` (a short description for screen readers; the title is used if empty).

## Talks

Edit `public/talks.json`. Each talk has `date`, `title`, `event`, `location`, `type` (keynote / talk / webinar / video / podcast / host, for MC and host slots), `url`, `youtube` (the 11-character video ID, or `null`), and optionally `note`, `mc` (`true` adds an "mc" tag for events Tyler also hosted) and `repo` (a public GitHub repo for the talk, shown as a "code ↗" link). To show a talk in **Highlighted videos** on the home page, give it `"highlight": 1` to `6` (the number sets its position).

## Demos

Edit `public/demos.json`. Each demo has `date`, `name`, `about` (one line), `event` (or `null`, e.g. for client work that can't be named) and `repo`. They show in the **Demos** section on the home page, newest first. A talk with a demo also gets `repo` in `talks.json`, which adds a "code" tag to its row.

## Editing data with SQL

`scripts/ch` is a tiny clickhouse-client for the site's JSON files, so you never hand-edit them:

```sh
scripts/ch                       # interactive: tylerhannan.com :) prompt, end statements with ;
scripts/ch "DESCRIBE talks"      # one-off
scripts/ch < changes.sql         # from a file
```

```sql
INSERT INTO talks (date, title, event, location, type, url, youtube)
VALUES ('2026-11-04', 'Kill Your Dashboards', 'Some Conf 2026', 'Paris, FR', 'talk', 'https://someconf.io', NULL);

ALTER TABLE talks UPDATE youtube = 'https://youtu.be/…' WHERE title = 'Kill Your Dashboards';
UPDATE photos SET camera = 'Rolleiflex 2.8e' WHERE place ILIKE '%singapore%';
DELETE FROM demos WHERE name = 'Thing';

SELECT date, title FROM talks WHERE youtube IS NULL ORDER BY date DESC LIMIT 5;
```

`INSERT`, `UPDATE` and `DELETE` rewrite `talks.json`, `demos.json` or `photos.json` in place, after checking each value against the table's schema (`DESCRIBE talks` shows it): dates, talk types, URLs, YouTube IDs (a full YouTube URL is accepted), unique highlight slots. Errors come back ClickHouse style (`Code: 16. DB::Exception: There is no column titel in table talks. Maybe you meant title?`). New rows go in date order without reshuffling the rest. `SELECT` (and anything else) runs on play.clickhouse.com with your local files sent along as tables, the same way the site's run buttons work, so you can check an edit before pushing. Photos are `UPDATE` only: add them with `scripts/add-photo.sh`. Nothing is committed; review with `git diff`, then commit and push.

## Runnable queries

The query boxes on the home, photos, archive and 404 pages run on real ClickHouse. Click **▶ run** to execute the query, or **edit** to change it first (⌘/Ctrl+Enter runs it while editing).

![Editing the talks query to add a date range, then querying the playground's UK house prices dataset](docs/runnable-queries.gif)

ClickHouse accepts SQL over plain HTTP, so `public/run.js` sends each query from the browser with a single `fetch()`: a POST to `https://play.clickhouse.com/?user=play` with the SQL as the body. `play` is the public [ClickHouse playground](https://play.clickhouse.com)'s read-only user and needs no password. The playground allows requests from any website (`Access-Control-Allow-Origin: *`), so there is no server of our own in between. Before sending a query, `run.js` does this:

- The site's data is sent along with each query as inline tables, so `talks`, `photos`, `posts` and `pages` work like real tables. For example, a query that mentions `talks` is sent as `WITH talks AS (SELECT * FROM values(...)) <your query>`.
- Anything else on the playground works too, such as `SHOW TABLES` or its demo datasets like `uk_price_paid`.
- Each query is wrapped in `SELECT * FROM (...) LIMIT 501 FORMAT JSONCompact`, and at most 500 rows are shown.
- Errors come back from ClickHouse as they are, minus the long list of expected tokens on syntax errors.

The `play` user can't change settings, read from URLs, use `format()`, or create temporary tables, so the inline data uses `values()`. Every query shown on the site has to be valid ClickHouse SQL, which is why the grouped talks views use `groupArray()`. To make a new query box runnable, give it `data-run` (`<div class="query" data-run>`) and load `/run.js` on the page. `DESCRIBE tyler` stays decorative.
