// The static site in public/, plus /api/embed?q=… for search: EmbeddingGemma on Workers AI, returned
// as 384 Int8 dims in base64, like embeddings.json, so the words and the pages are comparable.
const MODEL = '@cf/google/embeddinggemma-300m';
const DIMS = 384;
const MAX_CHARS = 200;  // keeps this from being a free embedding API

const json = (body, status, headers) => new Response(JSON.stringify(body) + '\n', {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/embed') return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405, { Allow: 'GET' });
    const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!q) return json({ error: 'Add ?q=some words' }, 400);

    // the cache key includes the size, so a DIMS change never serves stale answers
    const key = new Request(url.origin + '/api/embed?d=' + DIMS + '&q=' + encodeURIComponent(q));
    const hit = await caches.default.match(key);
    if (hit) return hit;

    let v;
    try {
      // the query prompt; pages use the document prompt
      const r = await env.AI.run(MODEL, { text: ['task: search result | query: ' + q] });
      v = r.data[0].slice(0, DIMS);
    } catch (e) {
      return json({ error: 'Workers AI: ' + (e && e.message || e) }, 502);
    }
    const max = Math.max(...v.map(Math.abs)) || 1;  // same scaling as embed.py
    const bytes = Uint8Array.from(v, (x) => Math.round(x * 127 / max) & 0xFF);
    const res = json({ model: MODEL, dims: DIMS, q, embedding: btoa(String.fromCharCode(...bytes)) }, 200,
      { 'Cache-Control': 'public, max-age=86400' });
    ctx.waitUntil(caches.default.put(key, res.clone()));
    return res;
  },
};
