// Search by meaning and spelling for the search, photos, archive and 404 pages. The browser ranks the rows
// itself, the same way the SQL does, so run gets the same answer from ClickHouse.
(function(){
  var cache={};
  var get=function(u){ return cache[u]||(cache[u]=fetch(u).then(function(r){ if(!r.ok) throw new Error(u+': HTTP '+r.status); return r.json(); })
    .catch(function(e){ delete cache[u]; throw e; })); };
  var dec=function(v){ try{ return decodeURIComponent(v); }catch(_){ return v; } };
  // base64 Int8, unpacked like run.js does in SQL
  var vec=function(b){ var s=atob(b), v=new Float32Array(s.length); for(var i=0;i<s.length;i++) v[i]=(s.charCodeAt(i)<<24)>>24; return v; };
  function cosine(a,b){ var d=0,x=0,y=0; for(var i=0;i<a.length;i++){ d+=a[i]*b[i]; x+=a[i]*a[i]; y+=b[i]*b[i]; } return d/Math.sqrt(x*y); }
  var vectors=function(){ return get('/embeddings.json').then(function(d){ return d.vectors||{}; },function(){ return {}; }); };

  // run.js's tables, each row with its vector (null if not embedded yet) and the key the SQL breaks ties on
  var TABLES={
    pages:function(){ return Promise.all([get('/archive/posts.json'),get('/talks.json'),get('/demos.json'),vectors(),get('/photos.json'),get('/writing.json')]).then(function(r){
      var row=function(path,title,k,event){ return {key:path,path:path,title:title,event:event||null,v:r[3][k]?vec(r[3][k]):null}; };
      return [{path:'/',title:'Home'},{path:'/photos/',title:'Photos'},{path:'/archive/',title:'Writing archive'}].concat(r[0].posts||[])
        .map(function(p){ return row(dec(p.path),p.title,p.path); })
        // talks and demos live on the home page; their vectors are keyed by their own link
        .concat((r[1].talks||[]).map(function(t){ return row(siteAnchor.talk(t),t.title+' · '+t.event,t.url||'https://www.youtube.com/watch?v='+t.youtube,t.event); }))
        .concat((r[2].demos||[]).map(function(d){ return row(siteAnchor.demo(d),d.name+' · demo',d.repo); }))
        // opens the photo in the viewer
        .concat((r[4].photos||[]).filter(function(p){ return p.file; }).map(function(p){ return row('/photos/#'+p.file.replace(/\.[^.]+$/,''),p.title+' · photo','/photos/'+p.file); }))
        .concat((r[5].writing||[]).map(function(w){ return row(w.url,w.title+' · '+w.venue,w.url); }));
    }); },
    posts:function(){ return Promise.all([get('/archive/posts.json'),vectors()]).then(function(r){
      return (r[0].posts||[]).map(function(p){ return {key:p.path,path:p.path,title:p.title,date:p.date,v:r[1][p.path]?vec(r[1][p.path]):null}; });
    }); },
    photos:function(){ return Promise.all([get('/photos.json'),vectors()]).then(function(r){
      return (r[0].photos||[]).filter(function(p){ return p.file; }).map(function(p){ var k='/photos/'+p.file; return {key:p.file,title:p.title,photo:p,v:r[1][k]?vec(r[1][k]):null}; });
    }); }
  };
  window.sitePages=TABLES.pages;

  // same order as the SQL: similarity rounded to 2 places, then key; no vector sorts last
  // byEvent is LIMIT 1 BY ifNull(event, path), so the release calls show once
  function rank(rows,q,limit,skip,byEvent){
    var seen={};
    return rows.filter(function(p){ return p.key!==skip; })
      .map(function(p){ p.similarity=p.v?Math.round(cosine(p.v,q)*100)/100:NaN; return p; })
      .sort(function(a,b){ return (isNaN(a.similarity)-isNaN(b.similarity)) || b.similarity-a.similarity || (a.key<b.key?-1:a.key>b.key?1:0); })
      .filter(function(p){ if(!byEvent) return true; var g=p.event==null?'path:'+p.key:'event:'+p.event; return seen[g]?false:(seen[g]=true); })
      .slice(0,limit||rows.length);
  }
  // embed the words, make them the request table, rank against them
  window.siteSearch=function(words,limit,table,byEvent){
    // d= matches the Worker's DIMS, so a cached answer is never the wrong size
    var req=get('/api/embed?d=384&q='+encodeURIComponent(words)).then(function(r){ return {words:words,e:r.embedding}; });
    window.siteRequest=req;
    return Promise.all([req,TABLES[table||'pages']()]).then(function(r){ return rank(r[1],vec(r[0].e),limit,null,byEvent); });
  };
  // rank against one of the table's own rows (no live embedding)
  window.siteSimilar=function(key,limit,table,byEvent){
    return TABLES[table||'pages']().then(function(rows){
      var me=rows.filter(function(p){ return p.key===key&&p.v; })[0];
      if(!me) throw new Error('No embedding for '+key+' yet (run scripts/embed.py).');
      return rank(rows,me.v,limit,key,byEvent);
    });
  };

// Search by spelling, like the SQL's round(ngramSearchCaseInsensitive(title, words), 2): the share of the
// words' 4-byte grams, lowercased, that also appear in the title.
  var utf8=function(s){ return unescape(encodeURIComponent(s.toLowerCase())); };
  function grams(s){ var m={},n=0; for(var i=0;i+4<=s.length;i++){ var g=s.substr(i,4); m[g]=(m[g]||0)+1; n++; } return {m:m,n:n}; }
  function ngramSearch(hay,needle){
    var N=grams(utf8(needle)), H=grams(utf8(hay)), hit=0, k;
    if(!N.n) return 1;  // as in ClickHouse, too short to have 4-grams matches everything
    for(k in N.m) hit+=Math.min(N.m[k],H.m[k]||0);
    return hit/N.n;
  }
  window.siteSpelling=function(words,limit,table){
    return TABLES[table||'pages']().then(function(rows){
      return rows.map(function(p){ return {path:p.path,title:p.title,match:Math.round(ngramSearch(p.title,words)*100)/100}; })
        .sort(function(a,b){ return b.match-a.match || (a.path<b.path?-1:a.path>b.path?1:0); }).slice(0,limit||rows.length);
    });
  };

// A search box: o.start, o.done(rows, words) and o.fail draw the results; ?q= searches on load.
  // run(words, x) searches from code, with x overriding o's callbacks for that run
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
