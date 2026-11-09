# Search, all in SQL

`site.sql` is the whole search: ClickHouse reads the live site with `url()`, embeds it with `aiEmbed`
(only rows that are new or changed), and answers searches through a parameterized view. The same
file runs on ClickHouse OSS and on ClickHouse Cloud.

## OSS

```sh
clickhousectl local use latest
ollama pull qwen3-embedding:0.6b    # Cloud provides the model; locally, Ollama does
```

OSS needs a named collection for the model and a setting that points `aiEmbed` at it. Cloud needs neither.

```sh
clickhouse local --path ./db --ai_function_embedding_default_credentials site_embed --multiquery --query "
  CREATE NAMED COLLECTION site_embed AS provider = 'openai', endpoint = 'http://localhost:11434/v1/embeddings'"
sed "s/'qwen3-embedding-8b'/'qwen3-embedding:0.6b'/" cloud/site.sql |
  clickhouse local --path ./db --ai_function_embedding_default_credentials site_embed --multiquery

# clickhouse local isn't a server: refreshes run only while it does, so run one and wait for it
clickhouse local --path ./db --ai_function_embedding_default_credentials site_embed --multiquery --query "
  SYSTEM REFRESH VIEW site.pages; SYSTEM WAIT VIEW site.pages;
  SYSTEM REFRESH VIEW site.embed; SYSTEM WAIT VIEW site.embed"
```

`cloud/test.sh` does this against a local copy of the site, and also checks that the rows match `scripts/embed.py`'s.

## Cloud

```sh
clickhousectl cloud auth login --api-key … --api-secret …
clickhousectl cloud service create --name tylerhannan-search --private-preview-terms-checked  # prints the password once
clickhousectl cloud service get --name tylerhannan-search    # wait for "running"; shows the host

clickhouse client --secure --host <host> --password <password> --queries-file cloud/site.sql
```

The service runs the first refresh by itself and the rest on schedule, so there's no refresh step here.

## Both: search, timings, model calls

```sql
SELECT * FROM site.search(q = 'neon signs at night');

SELECT * FROM site.related(path = '/2012/04/geektool/');

-- how long reading the site and embedding it took (in clickhouse local, only in the process that ran the refresh)
SELECT view, written_rows, last_success_duration_ms FROM system.view_refreshes WHERE database = 'site';

-- model calls made by the last search
SYSTEM FLUSH LOGS;
SELECT query_duration_ms, ProfileEvents['AIAPICalls'] FROM system.query_log
WHERE type = 'QueryFinish' AND query LIKE '%site.search(%' ORDER BY event_time DESC LIMIT 1;
```

On Cloud, read the system tables through `clusterAllReplicas(default, system.…)`, because a service has several replicas.

## After each deploy

The Workers Build deploy command is `npx wrangler deploy && sh cloud/refresh.sh`, which sends
`SYSTEM REFRESH VIEW` to the service over its HTTP interface. Without credentials it skips.

## Tear down

```sh
clickhousectl cloud service delete --name tylerhannan-search --force
```
