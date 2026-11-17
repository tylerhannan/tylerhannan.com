-- QBit on 1M DBpedia vectors (text-embedding-3-large, 3072 dims). Run once, then qbit-search.sql for q = 0..19.

CREATE DATABASE IF NOT EXISTS qbit;

CREATE TABLE qbit.f32  (id String, title String, v Array(Float32))              ENGINE = MergeTree ORDER BY id;
CREATE TABLE qbit.bf16 (id String, title String, v Array(BFloat16))             ENGINE = MergeTree ORDER BY id;
CREATE TABLE qbit.qb   (id String, title String, v QBit(BFloat16, 3072))        ENGINE = MergeTree ORDER BY id;
-- the first 1024 dims can be read on their own
CREATE TABLE qbit.qbs  (id String, title String, v QBit(BFloat16, 3072, 1024))  ENGINE = MergeTree ORDER BY id;

-- about 25 GB, 10 minutes
INSERT INTO qbit.f32
SELECT assumeNotNull(_id), assumeNotNull(title), CAST(`text-embedding-3-large-3072-embedding`, 'Array(Float32)')
FROM url('https://huggingface.co/datasets/Qdrant/dbpedia-entities-openai3-text-embedding-3-large-3072-1M/resolve/main/data/train-{00000..00062}-of-00063.parquet', Parquet)
SETTINGS max_http_get_redirects = 10;

INSERT INTO qbit.bf16 SELECT * FROM qbit.f32;
INSERT INTO qbit.qb   SELECT * FROM qbit.f32;
INSERT INTO qbit.qbs  SELECT * FROM qbit.f32;

SELECT name, formatReadableSize(total_bytes) AS size FROM system.tables WHERE database = 'qbit' ORDER BY name;

CREATE TABLE qbit.queries (q UInt8, words String, v Array(Float32)) ENGINE = MergeTree ORDER BY q;
INSERT INTO qbit.queries
SELECT n - 1, words[n], aiEmbed(words[n], 'text-embedding-3-large')
FROM (SELECT ['mountains in South America', 'jazz musicians from New Orleans', 'medieval castles in Scotland',
              'programming languages for data analysis', 'Olympic swimmers from Australia', 'French impressionist painters',
              'rivers that flow into the Black Sea', 'German football clubs', 'volcanoes in Japan',
              'physicists who won the Nobel Prize', 'cities on the Danube', 'species of owl', 'British rock bands of the 1970s',
              'space probes sent to Mars', 'Italian pasta dishes', 'suspension bridges', 'Roman emperors',
              'video game consoles', 'universities in California', 'open source databases'] AS words)
ARRAY JOIN arrayEnumerate(words) AS n;

CREATE TABLE qbit.answers (kind String, q UInt8, ids Array(String), at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY (kind, q);

-- now run qbit-search.sql for q = 0..19, then:
-- results: median time, and how many of the exact top 10 each kind found
SYSTEM FLUSH LOGS;
SELECT kind, seconds, read, right_of_10, worst
FROM
(
    SELECT log_comment AS kind, round(median(query_duration_ms) / 1000, 2) AS seconds, formatReadableSize(median(read_bytes)) AS read
    FROM clusterAllReplicas(default, system.query_log)
    WHERE type = 'QueryFinish' AND query_kind = 'Insert' AND has(databases, 'qbit') AND log_comment != ''
    GROUP BY kind
) AS t
INNER JOIN
(
    SELECT a.kind AS kind, round(avg(length(arrayIntersect(a.ids, e.ids))), 1) AS right_of_10, min(length(arrayIntersect(a.ids, e.ids))) AS worst
    FROM qbit.answers AS a INNER JOIN (SELECT q, ids FROM qbit.answers WHERE kind = 'f32') AS e USING (q)
    GROUP BY kind
) AS r USING (kind)
ORDER BY seconds DESC;
