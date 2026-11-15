// The static site in public/, plus three endpoints answered by ClickHouse Cloud (cloud/site.sql). The service
// embeds and ranks; this Worker holds site_searcher's password and caches the answers.
//   /api/search?q=   full-size search (site.search)
//   /api/related?path= a post's nearest posts, from stored vectors, no model call (site.related)
//   /api/embed?q=    the words as 384 Int8 dims in base64, for the request table on play (site.query_vector)
//   /embeddings.json every page's vector packed the same way, for the queries on play (site.compact)
// Without CLICKHOUSE_URL and CLICKHOUSE_SEARCH_PASSWORD (wrangler dev without .dev.vars) it answers 503.
const MODEL = 'qwen3-embedding-8b';
const DIMS = 384;
const MAX_CHARS = 200;  // keeps this from being a free embedding API
const DAY = 86400;

const json = (body, status, headers) => new Response(JSON.stringify(body) + '\n', {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers },
});

// cached at the edge; the key names the model and size, so a change never serves old answers
async function cached(key, ctx, make) {
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.status === 200) ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}

// one query as site_searcher; the words go as a parameter, never into the SQL (escaped format, so backslashes are doubled)
async function clickhouse(env, sql, q, name = 'q') {
  const r = await fetch(env.CLICKHOUSE_URL + '/' + (q == null ? '' : '?param_' + name + '=' + encodeURIComponent(q.replace(/\\/g, '\\\\'))), {
    method: 'POST',
    headers: { 'X-ClickHouse-User': env.CLICKHOUSE_SEARCH_USER || 'site_searcher', 'X-ClickHouse-Key': env.CLICKHOUSE_SEARCH_PASSWORD },
    body: sql,
  });
  const text = await r.text();
  if (!r.ok) throw new Error('ClickHouse: ' + text.slice(0, 300));
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const ROUTES = {
  '/api/search': {
    words: true, ttl: DAY,
    answer: async (env, q) => ({ q, results: await clickhouse(env,
      'SELECT similarity, kind, title, path FROM site.search(q = {q:String}) FORMAT JSONEachRow', q) }),
  },
  '/api/related': {
    words: true, param: 'path', ttl: DAY,
    answer: async (env, path) => ({ path, results: await clickhouse(env,
      'SELECT similarity, title, path FROM site.related(path = {path:String}) FORMAT JSONEachRow', path, 'path') }),
  },
  '/api/embed': {
    words: true, ttl: DAY,
    answer: async (env, q) => {
      const [row] = await clickhouse(env, 'SELECT e FROM site.query_vector(q = {q:String}) FORMAT JSONEachRow', q);
      return { model: MODEL, dims: DIMS, q, embedding: row.e };
    },
  },
  '/embeddings.json': {
    words: false, ttl: 3600,  // an hour, so a refresh after a push shows up soon
    answer: async (env) => {
      const vectors = {};
      for (const row of await clickhouse(env, 'SELECT path, e FROM site.compact ORDER BY path FORMAT JSONEachRow')) vectors[row.path] = row.e;
      return { model: MODEL, dims: DIMS, vectors };
    },
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = ROUTES[url.pathname];
    if (!route) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405, { Allow: 'GET' });
    if (!env.CLICKHOUSE_URL || !env.CLICKHOUSE_SEARCH_PASSWORD) return json({ error: 'Search is not set up' }, 503);

    const name = route.param || 'q';
    const q = route.words ? (url.searchParams.get(name) || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS) : null;
    if (route.words && !q) return json({ error: 'Add ?' + name + '=…' }, 400);
    const key = new Request(url.origin + url.pathname + '?m=' + MODEL + '&d=' + DIMS + (q == null ? '' : '&' + name + '=' + encodeURIComponent(q)));
    return cached(key, ctx, async () => {
      try {
        return json(await route.answer(env, q), 200, { 'Cache-Control': 'public, max-age=' + route.ttl });
      } catch (e) {
        console.error(e);  // details stay in the logs, not in the answer
        return json({ error: 'search failed' }, 502);
      }
    });
  },
};
