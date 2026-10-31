// Search by meaning, for the search boxes (home, photos, archive) and the 404 page.
// The words are embedded just now by EmbeddingGemma on Workers AI (/api/embed, src/worker.js) and compared with
// the vectors in /embeddings.json, made ahead of time with the same model (scripts/embed.py). The words also
// become the one-row `request` table that run.js sends to ClickHouse, so the query shown next to the results
// returns the same rows; the rows on the page are computed here, the same way, without the round trip.
(function(){
  var cache={};
  var get=function(u){ return cache[u]||(cache[u]=fetch(u).then(function(r){ if(!r.ok) throw new Error(u+': HTTP '+r.status); return r.json(); })
    .catch(function(e){ delete cache[u]; throw e; })); };
  var dec=function(v){ try{ return decodeURIComponent(v); }catch(_){ return v; } };
  // 384 Int8, base64 (the same unpacking run.js does in SQL)
  var vec=function(b){ var s=atob(b), v=new Float32Array(s.length); for(var i=0;i<s.length;i++) v[i]=(s.charCodeAt(i)<<24)>>24; return v; };
  function cosine(a,b){ var d=0,x=0,y=0; for(var i=0;i<a.length;i++){ d+=a[i]*b[i]; x+=a[i]*a[i]; y+=b[i]*b[i]; } return d/Math.sqrt(x*y); }
  var vectors=function(){ return get('/embeddings.json').then(function(d){ return d.vectors||{}; },function(){ return {}; }); };

  // The rows of run.js's tables, each with its vector (v is null for anything scripts/embed.py hasn't seen yet)
  // and `key`, the column the SQL breaks ties on (path, or file for photos).
  var TABLES={
    pages:function(){ return Promise.all([get('/archive/posts.json'),get('/talks.json'),get('/demos.json'),vectors(),get('/photos.json')]).then(function(r){
      var row=function(path,title,k,event){ return {key:path,path:path,title:title,event:event||null,v:r[3][k]?vec(r[3][k]):null}; };
      return [{path:'/',title:'Home'},{path:'/photos/',title:'Photos'},{path:'/archive/',title:'Writing archive'}].concat(r[0].posts||[])
        .map(function(p){ return row(dec(p.path),p.title,p.path); })
        // talks and demos: path is their row on the home page (site.js); vectors are keyed by their own link
        .concat((r[1].talks||[]).map(function(t){ return row(siteAnchor.talk(t),t.title+' · '+t.event,t.url||'https://www.youtube.com/watch?v='+t.youtube,t.event); }))
        .concat((r[2].demos||[]).map(function(d){ return row(siteAnchor.demo(d),d.name+' · demo',d.repo); }))
        // photos: path opens the photo in the gallery's viewer
        .concat((r[4].photos||[]).filter(function(p){ return p.file; }).map(function(p){ return row('/photos/#'+p.file.replace(/\.[^.]+$/,''),p.title+' · photo','/photos/'+p.file); }));
    }); },
    posts:function(){ return Promise.all([get('/archive/posts.json'),vectors()]).then(function(r){
      return (r[0].posts||[]).map(function(p){ return {key:p.path,path:p.path,title:p.title,date:p.date,v:r[1][p.path]?vec(r[1][p.path]):null}; });
    }); },
    photos:function(){ return Promise.all([get('/photos.json'),vectors()]).then(function(r){
      return (r[0].photos||[]).filter(function(p){ return p.file; }).map(function(p){ var k='/photos/'+p.file; return {key:p.file,title:p.title,photo:p,v:r[1][k]?vec(r[1][k]):null}; });
    }); }
  };
  window.sitePages=TABLES.pages;  // the 404 page's spelling query uses the same rows

  // ORDER BY similarity DESC (rounded to 2 places, as the SQL does), key; rows without a vector go last.
  // byEvent: LIMIT 1 BY ifNull(event, path), so a run of talks at one event (release calls) shows once.
  function rank(rows,q,limit,skip,byEvent){
    var seen={};
    return rows.filter(function(p){ return p.key!==skip; })
      .map(function(p){ p.similarity=p.v?Math.round(cosine(p.v,q)*100)/100:NaN; return p; })
      .sort(function(a,b){ return (isNaN(a.similarity)-isNaN(b.similarity)) || b.similarity-a.similarity || (a.key<b.key?-1:a.key>b.key?1:0); })
      .filter(function(p){ if(!byEvent) return true; var g=p.event==null?'path:'+p.key:'event:'+p.event; return seen[g]?false:(seen[g]=true); })
      .slice(0,limit||rows.length);
  }
  // Embed the words, make them the `request` table, and rank a table's rows against them.
  window.siteSearch=function(words,limit,table,byEvent){
    // d= matches src/worker.js's DIMS, so a browser never reuses an answer cached at another size
    var req=get('/api/embed?d=384&q='+encodeURIComponent(words)).then(function(r){ return {words:words,e:r.embedding}; });
    window.siteRequest=req;
    return Promise.all([req,TABLES[table||'pages']()]).then(function(r){ return rank(r[1],vec(r[0].e),limit,null,byEvent); });
  };
  // Rank a table's rows against one of its own rows (no live embedding needed).
  window.siteSimilar=function(key,limit,table,byEvent){
    return TABLES[table||'pages']().then(function(rows){
      var me=rows.filter(function(p){ return p.key===key&&p.v; })[0];
      if(!me) throw new Error('No embedding for '+key+' yet (run scripts/embed.py).');
      return rank(rows,me.v,limit,key,byEvent);
    });
  };

  // A search box: o.form holds o.input, o.box is the runnable query showing the SQL, and the page draws the rows.
  // o.start(words) as a search begins, o.done(rows, words) with the ranked rows, o.fail(words) if it can't.
  // ?q= in the URL searches on load; a new search makes any ▶ run result for the old one go away.
  // run(words, x) searches from code; x can replace o's start/search/done/fail for that one run.
  window.siteSearchBox=function(o){
    var n=0;
    function run(words,x){
      var id=++n, f=function(name){ return (x&&x[name])||o[name]; };
      if(o.box) o.box.dispatchEvent(new Event('query-changed'));
      f('start')(words);
      (f('search')||function(){ return window.siteSearch(words,o.limit,o.table,o.byEvent); })(words).then(function(rows){ if(id===n) f('done')(rows,words); },
        function(e){ if(id===n) f('fail')(words,e); });
    }
    o.form.addEventListener('submit',function(e){
      e.preventDefault();
      var words=o.input.value.replace(/\s+/g,' ').trim(); if(!words) return;
      try{ history.replaceState(null,'','?q='+encodeURIComponent(words)+(o.hash||'')); }catch(_){}
      run(words);
    });
    var q=(new URLSearchParams(location.search).get('q')||'').replace(/\s+/g,' ').trim();
    if(q){ o.input.value=q; run(q); }
    return {run:run};
  };
})();
