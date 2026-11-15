# tylerhannan.com

My site. It's a folder of HTML and JSON files in `public/`, with no build step and no database of its own. Every query box on it is real SQL that runs on [play.clickhouse.com](https://clickhouse.com/docs/get-started/sample-datasets/playground), the public ClickHouse playground, with the site's data sent along as tables. Search by meaning is all SQL too: [ClickHouse Cloud](https://clickhouse.com/cloud) reads the site, embeds it with [`aiEmbed`](https://clickhouse.com/docs/reference/functions/regular-functions/ai-functions) and answers searches (`cloud/site.sql`).

It's hosted on Cloudflare Workers (`wrangler.jsonc`), and every push to `main` deploys. The only server code is `src/worker.js`, which passes searches to ClickHouse Cloud and caches the answers.

Preview locally:

```
cd public && python3 -m http.server 8000     # everything except search by meaning
npx wrangler dev                              # everything, with the ClickHouse Cloud settings in .dev.vars (cloud/README.md)
```

## How the query boxes work

ClickHouse speaks SQL over HTTP, and the playground has a read-only `play` user with no password that accepts requests from any website. So `public/run.js` is one `fetch()`: it POSTs the SQL to `https://play.clickhouse.com/?user=play`.

The playground won't let me store anything, so the data comes along with the query. `run.js` looks at which of the site's tables your query mentions, turns each one into a CTE with `values()`, and puts it in front of your SQL:

```sql
WITH talks AS (SELECT * FROM values('date Date, title String, …', (…), (…)))
SELECT toYear(date) AS year, count() FROM talks GROUP BY year
```

The tables are `talks`, `demos`, `photos`, `posts` (the old blog), `writing` (posts I wrote for other sites) and `pages` (all of it, for search). Anything else on the playground works too, like `SHOW TABLES` or `github_events`. Results are capped at 500 rows.

To make a new box runnable, give it `data-run` (`<div class="query" data-run>`) and load `/run.js`. Every query shown on the site has to be valid ClickHouse SQL, which is why the grouped talk views use `groupArray()`.

![Editing the talks query, then querying the playground's own data](docs/runnable-queries.gif)

## Search

The search page, the photos and writing pages, each talk's "more like this", each old post's nearest posts and the 404 page all rank by meaning with `cosineDistance`. The search page and the 404 page rank by spelling too, with `ngramSearchCaseInsensitive`.

- **Made by ClickHouse Cloud:** `cloud/site.sql` has the service read the live site with `url()` (pages, old posts with their text from `archive/text.json`, talks, demos, photo captions, posts on other sites) and embed each row with `aiEmbed` and Qwen3-Embedding-8B, the service's built-in model. After a push, `.github/workflows/search-refresh.yml` asks it to refresh, and only new or changed rows get embedded again. Nothing runs on my laptop.
- **Served by the Worker:** `/api/search?q=` is the full-size search (4096 dims), done entirely in ClickHouse. `/api/embed?q=` and `/embeddings.json` give the words and every page as the first 384 dims in Int8, for the queries you can run on play. The Worker holds the password of a user that can only read the site's tables, with one model call per search.
- **The ranking:** your browser does the same math as the SQL, so results show up right away. Press run and the exact query goes to the playground and returns the same rows. A post's nearest posts run on play when that box scrolls into view.

There's a limit, though. Every search on play sends the whole `pages` table along with the query, and the playground's `max_query_size` is 256 KB. It's about 202 KB today. `run.js` checks the size before sending and says "Not sent" if a query is too big, so you get a plain message instead of an error. The full-size search on Cloud has no such limit.

To try a change to the SQL before pushing it, `sh cloud/test.sh` runs `cloud/site.sql` against a local copy of the site with `clickhouse local` and Ollama (`ollama pull qwen3-embedding:0.6b`). Setup, users and secrets are in `cloud/README.md`.

## Editing the data

`scripts/ch` is a tiny clickhouse-client for the JSON files, so I don't hand-edit them:

```sql
INSERT INTO talks (date, title, event, location, type, url, youtube)
VALUES ('2026-11-04', 'Kill Your Dashboards', 'Some Conf 2026', 'Paris, FR', 'talk', 'https://someconf.io', NULL);

UPDATE photos SET camera = 'Rolleiflex 2.8e' WHERE place ILIKE '%singapore%';
DELETE FROM demos WHERE name = 'Thing';

SELECT date, title FROM talks WHERE youtube IS NULL ORDER BY date DESC LIMIT 5;
```

Edits are checked against the schema (`DESCRIBE talks`) and rewrite the JSON in place. `SELECT` runs on the playground with your local files sent along, like the run buttons, so you can check an edit before pushing. Run it with no arguments for a `:)` prompt.

- **Talks** (`public/talks.json`): `date`, `title`, `event`, `location`, `type` (keynote, talk, webinar, video, interview or host), `url`, `youtube` (the video ID or `null`), and optionally `note`, `mc`, `repo` and `highlight` (1–6, for the home page's highlighted videos).
- **Demos** (`public/demos.json`): `date`, `name`, `about`, `event` (or `null`) and `repo`.
- **Writing** (`public/writing.json`): posts on other sites, with `date`, `title`, `venue`, `url` and optional `coauthors`.

## Photos

Export from Lightroom as sRGB JPEG, long edge 2000 px or more, with Remove Location Info ticked. Then:

```
scripts/add-photo.sh ~/Pictures/Export/IMG_1234.jpg "Title" "Place" "YYYY-MM"
```

It shrinks the photo to 2000 px (never enlarging), makes a 600 px thumbnail, strips the metadata, and adds it to `public/photos.json`. `scripts/strip_metadata.py` keeps only the pixels, the colour profile and the orientation: no GPS, no place names, no serial numbers. Write a sentence of `alt` text for each photo, because photo search only knows what's in the alt text. If the grid's crop cuts off the subject, add `"focus": "top"` (or `bottom`, `left`, `right`).

## The old blog

The old WordPress posts live at their original addresses (`/2012/04/…/`), so old links still work. They were converted from a WordPress export once, by a script I've since deleted: the old database had been hacked, and keeping a parser for a hacked database around was more trouble than it was worth. The pages are plain static HTML now, and their text for search is in `archive/text.json`.

## License

The code (HTML, CSS, JavaScript, `scripts/`, `src/`) is [MIT](LICENSE). Borrow whatever's useful.

The content isn't: the photos, the posts, and the talks, demos and writing data are © Tyler Hannan, all rights reserved. Images in old posts that came from elsewhere belong to their owners. Colours are [Selenized](https://github.com/jan-warchol/selenized) by Jan Warchoł (MIT).
