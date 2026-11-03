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

-- Everything the site is, read from the site itself
CREATE OR REPLACE VIEW site.docs AS
WITH
    'https://tylerhannan.com' AS base,
    -- " · ".join(x for x in (...) if x)
    (parts) -> arrayStringConcat(arrayFilter(x -> x != '', parts), ' · ') AS joined,
    (html) -> decodeHTMLComponent(extract(html, '<meta name="description" content="([^"]*)"')) AS description
SELECT path, kind, title, event, text
FROM
(
    SELECT 0 AS src, 1 AS i, '/' AS path, 'page' AS kind, 'Home' AS title, NULL AS event,
           description(raw_blob) AS text FROM url(base || '/', RawBLOB)
    UNION ALL
    SELECT 0, 2, '/photos/', 'page', 'Photos', NULL, description(raw_blob) FROM url(base || '/photos/', RawBLOB)
    UNION ALL
    SELECT 0, 3, '/archive/', 'page', 'Writing archive', NULL, description(raw_blob) FROM url(base || '/archive/', RawBLOB)
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
LIMIT 1 BY path;

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

-- The search: Qwen3-Embedding's query format, one row per event (a series like the release calls shows once)
CREATE OR REPLACE VIEW site.search AS
SELECT round(1 - cosineDistance(v, aiEmbed('Instruct: Given a search query, find the pages, posts, talks, demos and '
                                           || 'photos on a personal website that match it\nQuery: ' || {q:String},
                                           'qwen3-embedding-8b')), 2) AS similarity,
       kind, title, path
FROM site.vectors
INNER JOIN site.pages USING (path, h)
ORDER BY similarity DESC, path
LIMIT 1 BY ifNull(event, path)
LIMIT 10;

-- Nearest posts to a post: no model call at all, just the stored vectors
CREATE OR REPLACE VIEW site.related AS
WITH (SELECT any(v) FROM site.vectors INNER JOIN site.pages USING (path, h) WHERE path = {path:String}) AS me
SELECT round(1 - cosineDistance(v, me), 2) AS similarity, title, path
FROM site.vectors
INNER JOIN site.pages USING (path, h)
WHERE kind = 'post' AND path != {path:String}
ORDER BY similarity DESC, path
LIMIT 5;
