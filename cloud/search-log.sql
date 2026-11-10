-- What people searched for on tylerhannan.com: the Cloud search logs itself. Run it as an admin (the default
-- user, or clickhousectl cloud service query); site_searcher can't read the query log, by design.
-- Private: these are words visitors typed. Repeat searches are answered from the Worker's cache for a day, so
-- each distinct search shows up about once a day, however often it was run.
--
--   clickhousectl cloud service query --name tylerhannan-search --queries-file cloud/search-log.sql --format PrettyCompact

WITH searches AS
(
    SELECT
        event_time,
        -- the Worker sends site.search(q = {q:String}); the log has the words filled in, quoted and escaped
        replaceRegexpAll(extract(query, 'site\\.search`?\\(q = \'((?:[^\'\\\\]|\\\\.)*)\'\\)'), '\\\\(.)', '\\1') AS words,
        query_duration_ms
    FROM clusterAllReplicas(default, system.query_log)
    WHERE type = 'QueryFinish'
      AND user = 'site_searcher'
      AND query LIKE '%site.search%'  -- the log writes it `site.search`(…)
      AND event_date >= today() - 30
)
SELECT
    lower(words) AS search,
    count() AS times,
    uniqExact(toDate(event_time)) AS days,
    min(event_time) AS first_seen,
    max(event_time) AS last_seen,
    round(avg(query_duration_ms)) AS avg_ms
FROM searches
WHERE words != ''
GROUP BY search
ORDER BY times DESC, last_seen DESC
LIMIT 100
