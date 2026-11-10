// tylerhannan.com: the static site in public/ (Workers static assets) plus one endpoint for search
// (public/search.js: the search, photos and archive pages, and the 404 page).
//
// GET /api/embed?q=some+words embeds the words with EmbeddingGemma on Workers AI and returns them in the same
// shape as public/embeddings.json (scripts/embed.py): the first 384 dimensions, scaled to Int8, base64.
// The site's pages were embedded with the same model (through Ollama), so the two are comparable.
//
// GET /api/search?q=some+words is the ClickHouse Cloud version (cloud/site.sql): the service embeds the words and
// searches in one query, as a user that may only read the site's tables, with one model call per query. This
// Worker only holds that user's password and caches answers. Not configured (no CLICKHOUSE_URL): 503.
const MODEL = '@cf/google/embeddinggemma-300m';
const DIMS = 384;
const MAX_CHARS = 200;  // a URL's worth of words; keeps the endpoint from being a free embedding API

const json = (body, status, headers) => new Response(JSON.stringify(body) + '\n', {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers },
});

const cached = async (key, ctx, make) => {
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.status === 200) ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
};

// The Cloud search: one parameterized query; the words travel as a query parameter, never inside the SQL
async function search(q, url, env, ctx) {
  if (!env.CLICKHOUSE_URL || !env.CLICKHOUSE_SEARCH_PASSWORD) return json({ error: 'Cloud search is not set up' }, 503);
  return cached(new Request(url.origin + '/api/search?v=1&q=' + encodeURIComponent(q)), ctx, async () => {
    // query parameters are read in ClickHouse's escaped format, so a backslash has to be doubled (q has no tabs or
    // newlines: whitespace was collapsed above)
    const r = await fetch(env.CLICKHOUSE_URL + '/?param_q=' + encodeURIComponent(q.replace(/\\/g, '\\\\')), {
      method: 'POST',
      headers: { 'X-ClickHouse-User': env.CLICKHOUSE_SEARCH_USER || 'site_searcher',
                 'X-ClickHouse-Key': env.CLICKHOUSE_SEARCH_PASSWORD },
      body: 'SELECT similarity, kind, title, path FROM site.search(q = {q:String}) FORMAT JSONEachRow',
    });
    const text = await r.text();
    if (!r.ok) return json({ error: 'ClickHouse: ' + text.slice(0, 300) }, 502);
    const results = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return json({ q, results }, 200, { 'Cache-Control': 'public, max-age=86400' });
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/embed' && url.pathname !== '/api/search') return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405, { Allow: 'GET' });
    const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!q) return json({ error: 'Add ?q=some words' }, 400);
    if (url.pathname === '/api/search') return search(q, url, env, ctx);

    // the cache key names the size, so answers cached before a change of DIMS are never served
    const key = new Request(url.origin + '/api/embed?d=' + DIMS + '&q=' + encodeURIComponent(q));
    const hit = await caches.default.match(key);
    if (hit) return hit;

    let v;
    try {
      // EmbeddingGemma's query prompt; the pages used its document prompt ("title: … | text: …")
      const r = await env.AI.run(MODEL, { text: ['task: search result | query: ' + q] });
      v = r.data[0].slice(0, DIMS);
    } catch (e) {
      return json({ error: 'Workers AI: ' + (e && e.message || e) }, 502);
    }
    const max = Math.max(...v.map(Math.abs)) || 1;  // the same scaling as scripts/embed.py
    const bytes = Uint8Array.from(v, (x) => Math.round(x * 127 / max) & 0xFF);
    const res = json({ model: MODEL, dims: DIMS, q, embedding: btoa(String.fromCharCode(...bytes)) }, 200,
      { 'Cache-Control': 'public, max-age=86400' });
    ctx.waitUntil(caches.default.put(key, res.clone()));
    return res;
  },
};
