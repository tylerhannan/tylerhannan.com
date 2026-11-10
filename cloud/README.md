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

`cloud/test.sh` does this against a local copy of the site, and also checks that every page, post, talk, demo and
photo in the site's JSON became a row.

## Cloud

Everything here is a terminal command; nothing needs the Cloud console after the API key.

```sh
clickhousectl cloud auth login --api-key … --api-secret …
clickhousectl cloud service create --name tylerhannan-search --private-preview-terms-checked  # prints the password once
clickhousectl cloud service get --name tylerhannan-search    # wait for "running"; shows the host

HOST=<host>
clickhouse client --secure --host $HOST --password <password> --queries-file cloud/site.sql
```

The service runs the first refresh by itself, and later ones on a schedule and after each push (below).

Two users, each allowed one job. `site.sql` made their roles: `site_search` reads the views and their tables, one
model call of one text per query; `site_refresh` refreshes the views. Cloud wants passwords with an uppercase
letter and a special character. The passwords go straight from here into the places that use them:

```sh
SEARCH_PW=Q_$(openssl rand -hex 24); REFRESH_PW=Q_$(openssl rand -hex 24)
clickhouse client --secure --host $HOST --password <password> --multiquery --query "
  CREATE USER IF NOT EXISTS site_searcher IDENTIFIED BY '$SEARCH_PW';
  GRANT site_search TO site_searcher;  ALTER USER site_searcher DEFAULT ROLE site_search;
  CREATE USER IF NOT EXISTS site_refresher IDENTIFIED BY '$REFRESH_PW';
  GRANT site_refresh TO site_refresher;  ALTER USER site_refresher DEFAULT ROLE site_refresh;"

# the Worker's /api/search (src/worker.js); takes effect on the next deploy of main
echo "https://$HOST:8443" | npx wrangler secret put CLICKHOUSE_URL
echo "$SEARCH_PW" | npx wrangler secret put CLICKHOUSE_SEARCH_PASSWORD

# the GitHub Action that refreshes after a push (.github/workflows/search-refresh.yml)
gh secret set CLICKHOUSE_URL --body "https://$HOST:8443"
gh secret set CLICKHOUSE_REFRESH_PASSWORD --body "$REFRESH_PW"
unset SEARCH_PW REFRESH_PW
```

Try it as the search user, the way the Worker calls it:

```sh
curl "https://$HOST:8443/?param_q=neon%20signs%20at%20night" -H "X-ClickHouse-User: site_searcher" \
  -H "X-ClickHouse-Key: …" --data-binary "SELECT * FROM site.search(q = {q:String}) FORMAT PrettyCompact"
```

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

## After each push

`.github/workflows/search-refresh.yml` runs `cloud/refresh.sh` when a push changes something the search reads.
It waits until the site serves the pushed files, then sends `SYSTEM REFRESH VIEW` over the HTTP interface as
`site_refresher`. Only new or changed rows are embedded. Without the secrets it skips.

## Things found while testing (26.8 Cloud, 26.11 OSS)

- Written inline, `aiEmbed` on the search words ran once per row of `site.vectors`: 269 embeddings of the same
  words per search. In a scalar subquery it runs once. `site.search` does that.
- `aiEmbed` fails inside a `SQL SECURITY DEFINER` view ("query context has expired"), even for the user who made
  it. So the views are ordinary ones, and the search role is limited by its settings profile instead.
- On Cloud, a user other than `default` needs `GRANT NAMED COLLECTION ON clickhouse_inference_embeddings` to call
  the built-in model.
- `ai_function_max_api_calls_per_query` counts requests, not texts, and one request can carry a batch. The search
  profile also sets `ai_function_embedding_max_batch_size = 1`.

## Tear down

```sh
clickhousectl cloud service delete --name tylerhannan-search --force
```
