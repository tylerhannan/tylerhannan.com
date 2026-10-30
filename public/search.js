// Search by meaning, for the home page's search box and the 404 page.
// The words are embedded just now by EmbeddingGemma on Workers AI (/api/embed, src/worker.js) and compared with
// every page's vector in /embeddings.json, made ahead of time with the same model (scripts/embed.py). The words
// also become the one-row `request` table that run.js sends to ClickHouse, so the query shown next to the
// results returns the same rows; the table on the page is computed here, without the round trip.
(function(){
  var cache={};
  var get=function(u){ return cache[u]||(cache[u]=fetch(u).then(function(r){ if(!r.ok) throw new Error(u+': HTTP '+r.status); return r.json(); })
    .catch(function(e){ delete cache[u]; throw e; })); };
  var dec=function(v){ try{ return decodeURIComponent(v); }catch(_){ return v; } };
  // 128 Int8, base64 (the same unpacking run.js does in SQL)
  var vec=function(b){ var s=atob(b), v=new Float32Array(s.length); for(var i=0;i<s.length;i++) v[i]=(s.charCodeAt(i)<<24)>>24; return v; };
  function cosine(a,b){ var d=0,x=0,y=0; for(var i=0;i<a.length;i++){ d+=a[i]*b[i]; x+=a[i]*a[i]; y+=b[i]*b[i]; } return d/Math.sqrt(x*y); }

  // The rows of run.js's `pages` table, each with its vector (v is null for a page scripts/embed.py hasn't seen yet).
  window.sitePages=function(){
    return Promise.all([get('/archive/posts.json'),get('/talks.json'),get('/demos.json'),get('/embeddings.json').catch(function(){ return {}; })]).then(function(r){
      var all=r[3].vectors||{}, row=function(path,title,key){ return {path:path,title:title,v:all[key]?vec(all[key]):null}; };
      return [{path:'/',title:'Home'},{path:'/photos/',title:'Photos'},{path:'/archive/',title:'Writing archive'}].concat(r[0].posts||[])
        .map(function(p){ return row(dec(p.path),p.title,p.path); })
        .concat((r[1].talks||[]).map(function(t){ var u=t.url||'https://www.youtube.com/watch?v='+t.youtube; return row(u,t.title+' · '+t.event,u); }))
        .concat((r[2].demos||[]).map(function(d){ return row(d.repo,d.name+' · demo',d.repo); }));
    });
  };

  // Embed the words, make them the `request` table, and return the nearest pages as {similarity, title, path},
  // ordered like the SQL: similarity (rounded to 2 places) descending, then path. Pages without a vector go last.
  window.siteSearch=function(words,limit){
    var req=get('/api/embed?q='+encodeURIComponent(words)).then(function(r){ return {words:words,e:r.embedding}; });
    window.siteRequest=req;
    return Promise.all([req,window.sitePages()]).then(function(r){
      var q=vec(r[0].e);
      return r[1].map(function(p){ return {similarity:p.v?Math.round(cosine(p.v,q)*100)/100:NaN,title:p.title,path:p.path}; })
        .sort(function(a,b){ return (isNaN(a.similarity)-isNaN(b.similarity)) || b.similarity-a.similarity || (a.path<b.path?-1:a.path>b.path?1:0); })
        .slice(0,limit);
    });
  };
})();
