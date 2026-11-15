-- A topic for every row without one, as scripts/ch UPDATEs. Only for GROUP BY: not shown, not embedded.
WITH
    (s -> concat('''', replaceAll(replaceAll(s, '\\', '\\\\'), '''', '\\'''), '''')) AS lit,
    -- the model sees the descriptions; the topic is the part before the colon
    ['Payments & commerce: payment processing, cards, fees, fraud, breaches, PCI compliance, merchants, payment and commerce platforms and APIs (PayPal, IP Commerce)',
     'Developer communities: devrel, evangelism, meetups, contributors, champions, community programs',
     'NoSQL databases: Riak, Fauna, key/value and document stores, availability, replication, data modelling',
     'GraphQL: GraphQL APIs, Hasura, schemas, GraphQL events',
     'Search & observability: Elasticsearch, Elastic, logging, monitoring, alerting',
     'ClickHouse & real-time analytics: ClickHouse, columnar OLAP, streaming ingestion, dashboards, query performance',
     'AI & agents: AI, LLMs, agents, embeddings, MCP, vector search',
     'Open source: open source projects, licensing, governance, contributors over time',
     'Personal: family, loss, music, travel, photography, holidays, life outside work, blog housekeeping'] AS topics
SELECT 'UPDATE ' || tbl || ' SET topic = '
       -- it sometimes answers {"category": "..."}
       || lit(splitByChar(':', if(startsWith(trimBoth(answer), '{'), JSONExtractString(trimBoth(answer), 'category'), trimBoth(answer)))[1])
       || ' WHERE ' || key || ';'
FROM
(
    SELECT tbl, key, aiClassify(text, topics, map('max_tokens', '2000')) AS answer
    FROM
    (
      SELECT * FROM
      (
        SELECT 'posts' AS tbl, 'path = ' || lit(JSONExtractString(p, 'path')) AS key,
               JSONExtractString(p, 'title') || '. ' || substring(texts[JSONExtractString(p, 'path')], 1, 2000) AS text
        FROM url({base:String} || '/archive/posts.json', RawBLOB)
        ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'posts') AS p
        CROSS JOIN (SELECT CAST(JSONExtract(raw_blob, 'posts', 'Array(Tuple(path String, text String))'), 'Map(String, String)') AS texts
                    FROM url({base:String} || '/archive/text.json', RawBLOB)) AS t
        WHERE JSONExtractString(p, 'topic') = ''
        UNION ALL
        SELECT 'writing', 'url = ' || lit(JSONExtractString(w, 'url')),
               JSONExtractString(w, 'title') || ' (' || JSONExtractString(w, 'venue') || '). ' || JSONExtractString(w, 'ai_summary')
        FROM url({base:String} || '/writing.json', RawBLOB) ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'writing') AS w
        WHERE JSONExtractString(w, 'topic') = ''
        UNION ALL
        SELECT 'talks', 'date = ' || lit(JSONExtractString(t, 'date')) || ' AND event = ' || lit(JSONExtractString(t, 'event'))
                        || ' AND title = ' || lit(JSONExtractString(t, 'title')),
               arrayStringConcat(arrayFilter(x -> x != '', [JSONExtractString(t, 'title'), JSONExtractString(t, 'event'), JSONExtractString(t, 'note')]), ' · ')
        FROM url({base:String} || '/talks.json', RawBLOB) ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'talks') AS t
        WHERE JSONExtractString(t, 'topic') = ''
        UNION ALL
        SELECT 'demos', 'repo = ' || lit(JSONExtractString(d, 'repo')), JSONExtractString(d, 'name') || ': ' || JSONExtractString(d, 'about')
        FROM url({base:String} || '/demos.json', RawBLOB) ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'demos') AS d
        WHERE JSONExtractString(d, 'topic') = ''
      )
      LIMIT 100  -- the call cap; the rest wait for the next run
    )
)
FORMAT TSVRaw
