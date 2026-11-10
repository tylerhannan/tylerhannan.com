// tylerhannan.com: the static site in public/ (Workers static assets) plus three endpoints, all answered by
// ClickHouse Cloud (cloud/site.sql). The service embeds and ranks; this Worker holds the password of site_searcher
// (a user that may only read the site's tables, one model call of one text per query) and caches the answers.
//
// GET /api/search?q=words  the search: site.search embeds the words and ranks every page, at full size (4096 dims)
// GET /api/embed?q=words   the words embedded and packed for play.clickhouse.com (site.query_vector): the first 384
//                          dimensions as Int8, base64. search.js turns them into the `request` table
// GET /embeddings.json     every page's vector packed the same way (site.compact), for the queries anyone can run
//                          on play: photos, archive, the 404 page, each post's nearest posts (run.js, search.js)
//
// Not configured (no CLICKHOUSE_URL / CLICKHOUSE_SEARCH_PASSWORD, e.g. wrangler dev without .dev.vars): 503.
const MODEL = 'qwen3-embedding-8b';
const DIMS = 384;
const MAX_CHARS = 200;  // a URL's worth of words
const DAY = 86400;

const json = (body, status, headers) => new Response(JSON.stringify(body) + '\n', {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers },
});

// Answers are cached at the edge; the key names the model and size, so a change of either never serves old ones
async function cached(key, ctx, make) {
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.status === 200) ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}

// One query as site_searcher. The words travel as a query parameter, never inside the SQL. Parameters are read in
// ClickHouse's escaped format, so backslashes are doubled (q has no tabs or newlines: whitespace is collapsed).
async function clickhouse(env, sql, q) {
  const r = await fetch(env.CLICKHOUSE_URL + '/' + (q == null ? '' : '?param_q=' + encodeURIComponent(q.replace(/\\/g, '\\\\'))), {
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

    const q = route.words ? (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS) : null;
    if (route.words && !q) return json({ error: 'Add ?q=some words' }, 400);
    const key = new Request(url.origin + url.pathname + '?m=' + MODEL + '&d=' + DIMS + (q == null ? '' : '&q=' + encodeURIComponent(q)));
    return cached(key, ctx, async () => {
      try {
        return json(await route.answer(env, q), 200, { 'Cache-Control': 'public, max-age=' + route.ttl });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 502);
      }
    });
  },
};
