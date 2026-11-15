-- Search for tylerhannan.com, all in SQL: ClickHouse reads the site, embeds it with aiEmbed, keeps it current
-- and answers searches. Written for ClickHouse Cloud (Qwen3-Embedding-8B, no credentials needed); cloud/test.sh
-- runs it on OSS with Ollama and qwen3-embedding:0.6b.
--
--   site.docs     the live site as rows: pages, posts, talks, demos, photos, posts elsewhere
--   site.pages    a snapshot of site.docs; cloud/refresh.sh refreshes it after a deploy (weekly as a backstop)
--   site.vectors  4096-dim vectors; site.embed adds one only for a new or changed row
--   site.search, site.related, site.compact, site.query_vector  what the Worker serves

CREATE DATABASE IF NOT EXISTS site;

-- read from the cloud-ai-functions branch on GitHub until it's merged; then 'https://tylerhannan.com'
CREATE OR REPLACE VIEW site.docs AS
WITH
    'https://raw.githubusercontent.com/tylerhannan/tylerhannan.com/cloud-ai-functions/public' AS base,
    -- " · ".join(x for x in (...) if x)
    (parts) -> arrayStringConcat(arrayFilter(x -> x != '', parts), ' · ') AS joined,
    (html) -> decodeHTMLComponent(extract(html, '<meta name="description" content="([^"]*)"')) AS description
SELECT path, kind, title, event, topic, text
FROM
(
    SELECT 0 AS src, 1 AS i, '/' AS path, 'page' AS kind, 'Home' AS title, NULL AS event, NULL AS topic,
           description(raw_blob) AS text FROM url(base || '/index.html', RawBLOB)
    UNION ALL
    SELECT 0, 2, '/photos/', 'page', 'Photos', NULL, NULL, description(raw_blob) FROM url(base || '/photos/index.html', RawBLOB)
    UNION ALL
    SELECT 0, 3, '/archive/', 'page', 'Writing', NULL, NULL, description(raw_blob) FROM url(base || '/archive/index.html', RawBLOB)
    UNION ALL
    -- posts: titles from posts.json, the whole text from text.json; topic (here and below) is from aiClassify, for GROUP BY, not embedded
    SELECT 1, i, JSONExtractString(p, 'path'), 'post', JSONExtractString(p, 'title'), NULL, JSONExtract(p, 'topic', 'Nullable(String)'),
           texts[JSONExtractString(p, 'path')]
    FROM url(base || '/archive/posts.json', RawBLOB)
    ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'posts') AS p, arrayEnumerate(JSONExtractArrayRaw(raw_blob, 'posts')) AS i
    CROSS JOIN
    (
        SELECT CAST(JSONExtract(raw_blob, 'posts', 'Array(Tuple(path String, text String))'), 'Map(String, String)') AS texts
        FROM url(base || '/archive/text.json', RawBLOB)
    ) AS t
    UNION ALL
    -- talks: keyed by their link (two talks can share a playlist link; the first one wins)
    SELECT 2, i,
           ifNull(nullIf(JSONExtract(t, 'url', 'Nullable(String)'), ''), 'https://www.youtube.com/watch?v=' || JSONExtractString(t, 'youtube')),
           'talk', JSONExtractString(t, 'title'), JSONExtractString(t, 'event'), JSONExtract(t, 'topic', 'Nullable(String)'),
           joined([JSONExtractString(t, 'event'), JSONExtractString(t, 'location'), JSONExtractString(t, 'note')])
    FROM url(base || '/talks.json', RawBLOB)
    ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'talks') AS t, arrayEnumerate(JSONExtractArrayRaw(raw_blob, 'talks')) AS i
    UNION ALL
    SELECT 3, i, JSONExtractString(d, 'repo'), 'demo', JSONExtractString(d, 'name'), NULL, JSONExtract(d, 'topic', 'Nullable(String)'),
           joined(['A demo: ' || JSONExtractString(d, 'about'), JSONExtractString(d, 'event')])
    FROM url(base || '/demos.json', RawBLOB)
    ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'demos') AS d, arrayEnumerate(JSONExtractArrayRaw(raw_blob, 'demos')) AS i
    UNION ALL
    -- photos: embedded from their captions (title, alt text, place), keyed by the image's URL
    SELECT 4, i, '/photos/' || JSONExtractString(ph, 'file'), 'photo', JSONExtractString(ph, 'title'), NULL, NULL,
           joined(['A photo: ' || if(JSONExtractString(ph, 'alt') != '', JSONExtractString(ph, 'alt'), JSONExtractString(ph, 'title')),
                   JSONExtractString(ph, 'place')])
    FROM url(base || '/photos.json', RawBLOB)
    ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'photos') AS ph, arrayEnumerate(JSONExtractArrayRaw(raw_blob, 'photos')) AS i
    WHERE JSONExtractString(ph, 'file') != ''
    UNION ALL
    -- posts on other sites, keyed by the post's url: the title, plus the AI summary made from the post with aiGenerate
    SELECT 5, i, JSONExtractString(w, 'url'), 'writing', JSONExtractString(w, 'title'), NULL, JSONExtract(w, 'topic', 'Nullable(String)'),
           joined(['A post on ' || JSONExtractString(w, 'venue'),
                   if(JSONExtractString(w, 'coauthors') != '', 'with ' || JSONExtractString(w, 'coauthors'), ''),
                   JSONExtractString(w, 'ai_summary')])
    FROM url(base || '/writing.json', RawBLOB)
    ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'writing') AS w, arrayEnumerate(JSONExtractArrayRaw(raw_blob, 'writing')) AS i
)
ORDER BY src, i
LIMIT 1 BY path
SETTINGS max_http_get_redirects = 1;  -- the live site redirects /index.html to /

-- A snapshot, so searches never wait on the site
CREATE MATERIALIZED VIEW IF NOT EXISTS site.pages
REFRESH EVERY 1 WEEK
ENGINE = MergeTree ORDER BY path
AS SELECT path, kind, title, event, topic, text, cityHash64(title, text) AS h FROM site.docs;

-- One vector per version of a row's text; the search only uses the current one
CREATE TABLE IF NOT EXISTS site.vectors
(
    path String,
    h UInt64,
    v Array(Float32)
)
ENGINE = ReplacingMergeTree ORDER BY (path, h);

-- embed only what's new or changed; documents go in as they are, only queries get an instruction
CREATE MATERIALIZED VIEW IF NOT EXISTS site.embed
REFRESH EVERY 1 WEEK DEPENDS ON site.pages APPEND
TO site.vectors
AS SELECT path, h, aiEmbed(title || '\n' || text, 'qwen3-embedding-8b') AS v
FROM site.pages
WHERE (path, h) NOT IN (SELECT path, h FROM site.vectors);

-- the words are embedded once, in a scalar subquery: inline, aiEmbed runs once per row (it isn't constant-folded)
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

-- nearest posts: stored vectors only, no model call
CREATE OR REPLACE VIEW site.related AS
WITH (SELECT any(v) FROM site.vectors INNER JOIN site.pages USING (path, h) WHERE path = {path:String}) AS me
SELECT round(1 - cosineDistance(v, me), 2) AS similarity, title, path
FROM site.vectors
INNER JOIN site.pages USING (path, h)
WHERE kind = 'post' AND path != {path:String}
ORDER BY similarity DESC, path
LIMIT 5;

-- the first 384 of 4096 dims as Int8 base64, small enough for play's 256 KB queries (/embeddings.json)
CREATE OR REPLACE VIEW site.compact AS
SELECT path, base64Encode(arrayStringConcat(arrayMap(x -> char(if(x < 0, toInt16(x) + 256, x)), q))) AS e
FROM
(
    SELECT path, arrayMap(x -> toInt8(round(x * 127 / arrayMax(arrayMap(abs, s)))), s) AS q
    FROM (SELECT path, arraySlice(v, 1, 384) AS s FROM site.vectors INNER JOIN site.pages USING (path, h))
);

-- the search words packed the same way, for /api/embed
CREATE OR REPLACE VIEW site.query_vector AS
WITH (SELECT arraySlice(aiEmbed('Instruct: Given a search query, find the pages, posts, talks, demos and photos on '
                                || 'a personal website that match it\nQuery: ' || {q:String}, 'qwen3-embedding-8b'), 1, 384)) AS s
SELECT base64Encode(arrayStringConcat(arrayMap(x -> char(if(x < 0, toInt16(x) + 256, x)),
                                               arrayMap(x -> toInt8(round(x * 127 / arrayMax(arrayMap(abs, s)))), s)))) AS e;

-- Users are made at setup (cloud/README.md), with names that differ from the roles (GRANT x TO x is ambiguous).
-- There's no AI privilege yet and aiEmbed fails in SQL SECURITY DEFINER views (#130746), so the searcher is
-- read-only with one model call of one text per query: enough for a search, useless as a free embedding API.
CREATE ROLE IF NOT EXISTS site_search;
GRANT SELECT ON site.search TO site_search;
GRANT SELECT ON site.related TO site_search;
GRANT SELECT ON site.vectors TO site_search;
GRANT SELECT ON site.pages TO site_search;
GRANT SELECT ON site.compact TO site_search;
GRANT SELECT ON site.query_vector TO site_search;
-- a user other than default needs this grant to reach Cloud's built-in model
GRANT NAMED COLLECTION ON clickhouse_inference_embeddings TO site_search;
CREATE SETTINGS PROFILE IF NOT EXISTS site_search
    SETTINGS readonly = 1, ai_function_max_api_calls_per_query = 1, ai_function_embedding_max_batch_size = 1,
             max_execution_time = 10
    TO site_search;

CREATE ROLE IF NOT EXISTS site_refresh;
GRANT SYSTEM VIEWS ON site.* TO site_refresh;
GRANT SELECT ON site.pages TO site_refresh;

-- cloud/enrich.sh: url() and the text model only. Table functions don't run under readonly, so the caps are CONST
CREATE ROLE IF NOT EXISTS site_enrich;
GRANT READ ON URL TO site_enrich;
GRANT CREATE TEMPORARY TABLE ON *.* TO site_enrich;
GRANT NAMED COLLECTION ON clickhouse_inference_completions TO site_enrich;
CREATE SETTINGS PROFILE IF NOT EXISTS site_enrich
    SETTINGS ai_function_max_api_calls_per_query = 100 CONST, max_execution_time = 600 CONST, max_http_get_redirects = 5
    TO site_enrich;
