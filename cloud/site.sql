-- Semantic search for tylerhannan.com, all in SQL: ClickHouse reads the site, embeds it, keeps it up to date
-- and answers searches. The Cloud counterpart of scripts/embed.py + src/worker.js + play.clickhouse.com.
--
-- Written for ClickHouse Cloud's AI functions (private preview), whose default embedding model there is
-- Qwen3-Embedding-8B (as of Nov 2026; could change before GA). Cloud provides the model, so this file has no
-- credentials or endpoint. Tested on ClickHouse 26.11 OSS by cloud/test.sh, which adds a named collection for
-- Ollama and swaps in the small qwen3-embedding:0.6b (same family and prompt format).
--
--   site.docs      a view over the live site: every page, post, talk, demo and photo, as title + text
--   site.pages     a snapshot of site.docs, with a hash of each row's text; cloud/refresh.sh refreshes it
--                  after every deploy (weekly too, in case a deploy's refresh failed)
--   site.vectors   embeddings; site.embed adds one only for a row that is new or whose text changed
--   site.search    parameterized view: SELECT * FROM site.search(q = 'some words')
--   site.related   parameterized view: SELECT * FROM site.related(path = '/2012/04/geektool/')
--
-- Rows are built exactly as scripts/embed.py builds them, so the two pipelines embed the same text. The models
-- differ: the static site uses EmbeddingGemma, cut to 384 Int8 dimensions to fit play's 256 KB query limit;
-- here it's Qwen3-Embedding-8B with all 4096 dimensions as Float32. So the two give different results.

CREATE DATABASE IF NOT EXISTS site;

-- Everything the site is, read from the site itself. While this is being tested, that's the cloud-ai-functions
-- branch on GitHub (main and the live site don't have archive/text.json); 'https://tylerhannan.com' once merged.
CREATE OR REPLACE VIEW site.docs AS
WITH
    'https://raw.githubusercontent.com/tylerhannan/tylerhannan.com/cloud-ai-functions/public' AS base,
    -- " · ".join(x for x in (...) if x)
    (parts) -> arrayStringConcat(arrayFilter(x -> x != '', parts), ' · ') AS joined,
    (html) -> decodeHTMLComponent(extract(html, '<meta name="description" content="([^"]*)"')) AS description
SELECT path, kind, title, event, text
FROM
(
    SELECT 0 AS src, 1 AS i, '/' AS path, 'page' AS kind, 'Home' AS title, NULL AS event,
           description(raw_blob) AS text FROM url(base || '/index.html', RawBLOB)
    UNION ALL
    SELECT 0, 2, '/photos/', 'page', 'Photos', NULL, description(raw_blob) FROM url(base || '/photos/index.html', RawBLOB)
    UNION ALL
    SELECT 0, 3, '/archive/', 'page', 'Writing archive', NULL, description(raw_blob) FROM url(base || '/archive/index.html', RawBLOB)
    UNION ALL
    -- posts: titles from posts.json, text from text.json (both written by scripts/import_wordpress.py)
    SELECT 1, i, JSONExtractString(p, 'path'), 'post', JSONExtractString(p, 'title'), NULL,
           texts[JSONExtractString(p, 'path')]
    FROM url(base || '/archive/posts.json', RawBLOB)
    ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'posts') AS p, arrayEnumerate(JSONExtractArrayRaw(raw_blob, 'posts')) AS i
    CROSS JOIN
    (
        SELECT CAST(JSONExtract(raw_blob, 'posts', 'Array(Tuple(path String, text String))'), 'Map(String, String)') AS texts
        FROM url(base || '/archive/text.json', RawBLOB)
    ) AS t
    UNION ALL
    -- talks: keyed by their link (two talks can share a playlist link; the first one wins, as in embed.py)
    SELECT 2, i,
           ifNull(nullIf(JSONExtract(t, 'url', 'Nullable(String)'), ''), 'https://www.youtube.com/watch?v=' || JSONExtractString(t, 'youtube')),
           'talk', JSONExtractString(t, 'title'), JSONExtractString(t, 'event'),
           joined([JSONExtractString(t, 'event'), JSONExtractString(t, 'location'), JSONExtractString(t, 'note')])
    FROM url(base || '/talks.json', RawBLOB)
    ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'talks') AS t, arrayEnumerate(JSONExtractArrayRaw(raw_blob, 'talks')) AS i
    UNION ALL
    SELECT 3, i, JSONExtractString(d, 'repo'), 'demo', JSONExtractString(d, 'name'), NULL,
           joined(['A demo: ' || JSONExtractString(d, 'about'), JSONExtractString(d, 'event')])
    FROM url(base || '/demos.json', RawBLOB)
    ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'demos') AS d, arrayEnumerate(JSONExtractArrayRaw(raw_blob, 'demos')) AS i
    UNION ALL
    -- photos: embedded from their captions (title, alt text, place), keyed by the image's URL
    SELECT 4, i, '/photos/' || JSONExtractString(ph, 'file'), 'photo', JSONExtractString(ph, 'title'), NULL,
           joined(['A photo: ' || if(JSONExtractString(ph, 'alt') != '', JSONExtractString(ph, 'alt'), JSONExtractString(ph, 'title')),
                   JSONExtractString(ph, 'place')])
    FROM url(base || '/photos.json', RawBLOB)
    ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'photos') AS ph, arrayEnumerate(JSONExtractArrayRaw(raw_blob, 'photos')) AS i
    WHERE JSONExtractString(ph, 'file') != ''
)
ORDER BY src, i
LIMIT 1 BY path
SETTINGS max_http_get_redirects = 1;  -- the live site redirects /index.html to /

-- A snapshot, so searches never wait on the site
CREATE MATERIALIZED VIEW IF NOT EXISTS site.pages
REFRESH EVERY 1 WEEK
ENGINE = MergeTree ORDER BY path
AS SELECT path, kind, title, event, text, cityHash64(title, text) AS h FROM site.docs;

-- One vector per version of a row's text; the search only uses the current one
CREATE TABLE IF NOT EXISTS site.vectors
(
    path String,
    h UInt64,
    v Array(Float32)
)
ENGINE = ReplacingMergeTree ORDER BY (path, h);

-- After each snapshot, embed only what's new or changed (a refresh with no changes makes no model calls).
-- Qwen3-Embedding takes documents as they are; only queries get an instruction (site.search).
CREATE MATERIALIZED VIEW IF NOT EXISTS site.embed
REFRESH EVERY 1 WEEK DEPENDS ON site.pages APPEND
TO site.vectors
AS SELECT path, h, aiEmbed(title || '\n' || text, 'qwen3-embedding-8b') AS v
FROM site.pages
WHERE (path, h) NOT IN (SELECT path, h FROM site.vectors);

-- The search: Qwen3-Embedding's query format, one row per event (a series like the release calls shows once).
-- The search words are embedded once, in a scalar subquery: written inline, aiEmbed would run once per row of
-- site.vectors (it isn't constant-folded), 269 embeddings of the same words per search.
CREATE OR REPLACE VIEW site.search AS
WITH (SELECT aiEmbed('Instruct: Given a search query, find the pages, posts, talks, demos and photos on a personal '
                     || 'website that match it\nQuery: ' || {q:String}, 'qwen3-embedding-8b')) AS query_vector
SELECT round(1 - cosineDistance(v, query_vector), 2) AS similarity,
       kind, title, path
FROM site.vectors
INNER JOIN site.pages USING (path, h)
ORDER BY similarity DESC, path
LIMIT 1 BY ifNull(event, path)
LIMIT 10;

-- Nearest posts to a post: no model call at all, just the stored vectors.
CREATE OR REPLACE VIEW site.related AS
WITH (SELECT any(v) FROM site.vectors INNER JOIN site.pages USING (path, h) WHERE path = {path:String}) AS me
SELECT round(1 - cosineDistance(v, me), 2) AS similarity, title, path
FROM site.vectors
INNER JOIN site.pages USING (path, h)
WHERE kind = 'post' AND path != {path:String}
ORDER BY similarity DESC, path
LIMIT 5;

-- Who may do what. The Worker searches (src/worker.js, /api/search); the GitHub Action refreshes after a push
-- (.github/workflows/search-refresh.yml). The users (site_searcher, site_refresher) and their passwords are made
-- at setup: cloud/README.md. Users and roles get different names: GRANT site_search TO site_search is ambiguous.
-- The searcher reads the views and the tables under them (the site's own public content). There's no separate
-- privilege for AI functions yet, and aiEmbed fails inside SQL SECURITY DEFINER views (26.8 Cloud, 26.11 OSS), so
-- instead its profile makes it read-only with one model call of one text per query: enough for a search, useless
-- as a free embedding API. (The calls cap alone isn't enough: one call can carry a whole batch of texts.)
CREATE ROLE IF NOT EXISTS site_search;
GRANT SELECT ON site.search TO site_search;
GRANT SELECT ON site.related TO site_search;
GRANT SELECT ON site.vectors TO site_search;
GRANT SELECT ON site.pages TO site_search;
-- Cloud's built-in model is reached through this named collection; a user other than default needs the grant
GRANT NAMED COLLECTION ON clickhouse_inference_embeddings TO site_search;
CREATE SETTINGS PROFILE IF NOT EXISTS site_search
    SETTINGS readonly = 1, ai_function_max_api_calls_per_query = 1, ai_function_embedding_max_batch_size = 1,
             max_execution_time = 10
    TO site_search;

CREATE ROLE IF NOT EXISTS site_refresh;
GRANT SYSTEM VIEWS ON site.* TO site_refresh;
GRANT SELECT ON site.pages TO site_refresh;
