// Makes every .query[data-run] box runnable on play.clickhouse.com, with the site's JSON sent along as tables.
// data-run="cloud" boxes run their data-api on ClickHouse Cloud through the Worker instead: same SQL, no edit.
(function(){
  var ENDPOINT='https://play.clickhouse.com/?user=play';
  var MAX_ROWS=500;  // a browser table doesn't need more
  var MAX_BYTES=2e6; // stop reading after ~2 MB so a big result can't freeze the tab
  // play's max_query_size, and the site's tables count toward it
  var MAX_QUERY=262144;
  var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
  var json={};
  function load(url){  // cached; a failed fetch gets retried
    return json[url]||(json[url]=fetch(url).then(function(r){ if(!r.ok) throw new Error(url+': HTTP '+r.status); return r.json(); })
      .catch(function(e){ delete json[url]; throw e; }));
  }

  // ---- the site's data as tables ----
  var day=function(d){ d=String(d||''); return d.length===4?d+'-01-01':d.length===7?d+'-01':d.slice(0,10); };
  var lit=function(v){ return typeof v==='boolean'?(v?'true':'false'):v==null?'NULL':typeof v==='number'?String(v):"'"+String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'"; };
  function cte(name,schema,rows,cols,select){
    var vals=rows.map(function(r){return '('+cols.map(function(c){return lit(r[c])}).join(', ')+')'}).join(', ');
    return name+' AS (SELECT '+(select||'*')+' FROM values('+lit(schema)+', '+(vals||'')+'))';
  }
  // vectors (from /embeddings.json, made by ClickHouse Cloud) travel as base64 Int8 to fit under 256 KB; missing ones are zeros
  var VEC='* EXCEPT (e), arrayMap(i -> toFloat32(reinterpretAsInt8(substring(base64Decode(e), i, 1))), range(1, length(base64Decode(e)) + 1)) AS embedding';
  function vectors(){ return load('/embeddings.json').then(function(d){
    var zero=btoa(new Array((d.dims||0)+1).join('\0'));
    return function(path){ return (d.vectors||{})[path]||zero; };
  }); }
  var TABLES={
    talks:function(){ return load('/talks.json').then(function(d){
      var rows=(d.talks||[]).map(function(t){var o={};for(var k in t)o[k]=t[k];o.date=day(t.date);return o});
      return cte('talks','date Date, title String, event String, location Nullable(String), type String, url Nullable(String), youtube Nullable(String), repo Nullable(String), highlight Nullable(UInt8), note Nullable(String), topic Nullable(String)',
        rows,['date','title','event','location','type','url','youtube','repo','highlight','note','topic']); }); },
    photos:function(){ return Promise.all([load('/photos.json'),vectors()]).then(function(r){
      var rows=(r[0].photos||[]).filter(function(p){return p.file}).map(function(p){var o={};for(var k in p)o[k]=p[k];o.date=day(p.date);o.e=r[1]('/photos/'+p.file);return o});
      return cte('photos','date Date, file String, title String, place Nullable(String), camera Nullable(String), alt Nullable(String), focus Nullable(String), e String',
        rows,['date','file','title','place','camera','alt','focus','e'],VEC); }); },
    posts:function(){ return Promise.all([load('/archive/posts.json'),vectors()]).then(function(r){
      var rows=(r[0].posts||[]).map(function(p){return {date:day(p.date),title:p.title,path:p.path,topic:p.topic||null,e:r[1](p.path)}});
      return cte('posts','date Date, title String, path String, topic Nullable(String), e String',rows,['date','title','path','topic','e'],VEC); }); },
    // my posts on other sites
    writing:function(){ return Promise.all([load('/writing.json'),vectors()]).then(function(r){
      var rows=(r[0].writing||[]).map(function(w){ return {date:day(w.date),title:w.title,venue:w.venue,url:w.url,coauthors:w.coauthors||null,ai_summary:w.ai_summary||null,topic:w.topic||null,e:r[1](w.url)}; });
      return cte('writing','date Date, title String, venue String, url String, coauthors Nullable(String), ai_summary Nullable(String), topic Nullable(String), e String',rows,['date','title','venue','url','coauthors','ai_summary','topic','e'],VEC); }); },
    demos:function(){ return load('/demos.json').then(function(d){
      var rows=(d.demos||[]).map(function(x){var o={};for(var k in x)o[k]=x[k];o.date=day(x.date);return o});
      return cte('demos','date Date, name String, about String, event Nullable(String), repo String, topic Nullable(String)',rows,['date','name','about','event','repo','topic']); }); },
    // every page, talk, demo, photo and post, for search and the 404 (rows from site.js, as in search.js)
    pages:function(){ return Promise.all([load('/archive/posts.json'),load('/talks.json'),load('/demos.json'),vectors(),load('/photos.json'),load('/writing.json')]).then(function(r){
      var rows=sitePageRows(r[0],r[1],r[2],r[4],r[5]).map(function(p){ return {path:p.path,title:p.title,event:p.event,e:r[3](p.k)}; });
      return cte('pages','path String, title String, event Nullable(String), e String',rows,['path','title','event','e'],VEC); }); },
    // the words just searched for, embedded by search.js
    request:function(){
      if(!window.siteRequest) return Promise.reject(new Error('There is no request table yet: search for something first (on /search/, or the 404 page).'));
      return window.siteRequest.then(function(q){ return cte('request','words String, e String',[q],['words','e'],VEC); }); }
  };

  // put the site tables in front of the query, merging any WITH
  function withTables(ctes,q){
    if(!ctes.length) return q;
    return /^WITH\b/i.test(q) ? 'WITH '+ctes.join(', ')+', '+q.replace(/^WITH\s+/i,'') : 'WITH '+ctes.join(', ')+' '+q;
  }
  function build(q){
    q=q.replace(/^\s*:\)\s*/,'').replace(/;(?:\s*(?:--[^\n]*|\/\*[\s\S]*?\*\/))*\s*$/,'');  // trailing ';' and comments after it
    q=q.replace(/^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))+/,'').trim();  // leading comments
    var bare=q.replace(/'(?:[^'\\]|\\.|'')*'|--[^\n]*|#[!\s][^\n]*|\/\*[\s\S]*?\*\//g,' ');  // a table name in a string or comment doesn't count
    var names=Object.keys(TABLES).filter(function(n){return new RegExp('\\b'+n+'\\b','i').test(bare)});
    return Promise.all(names.map(function(n){return TABLES[n]()})).then(function(ctes){
      var own=/\bFORMAT\s+\w+\s*$/i.test(q), fmt=own?'':' FORMAT JSONCompact', m;
      if(/^(SELECT|WITH)\b/i.test(q))  // newlines so a trailing -- comment can't eat the wrapper
        return {sql: own ? withTables(ctes,q) : withTables(ctes,'SELECT * FROM (\n'+q+'\n) LIMIT '+(MAX_ROWS+1))+fmt, raw:own};
      if((m=q.match(/^(EXPLAIN(?:\s+(?:AST|SYNTAX|QUERY\s+TREE|PLAN|PIPELINE|ESTIMATE))?(?:\s+\w+\s*=\s*\w+(?:\s*,\s*\w+\s*=\s*\w+)*)?)\s+((?:SELECT|WITH)\b[\s\S]*)$/i)))
        return {sql: m[1]+' '+withTables(ctes,m[2])+fmt, raw:own};
      if((m=q.match(/^(DESC(?:RIBE)?)(?:\s+TABLE)?\s+(talks|photos|posts|writing|pages|demos|request)\s*$/i)))  // site tables aren't real tables
        return {sql: m[1]+' ('+withTables(ctes,'SELECT * FROM '+m[2].toLowerCase())+')'+fmt};
      return {sql:q+fmt, raw:own};  // SHOW, other DESCRIBE/EXPLAIN …
    });
  }

  // read at most MAX_BYTES
  function readCapped(r,ctrl){
    if(!r.body||!r.body.getReader) return r.text().then(function(t){ return {text:t,cut:false}; });
    var reader=r.body.getReader(), dec=new TextDecoder(), text='', n=0;
    return (function pump(){ return reader.read().then(function(c){
      if(c.done) return {text:text+dec.decode(),cut:false};
      n+=c.value.length; text+=dec.decode(c.value,{stream:true});
      if(n>MAX_BYTES){ ctrl.abort(); return {text:text,cut:true}; }
      return pump();
    }); })();
  }

  // ---- rendering ----
  function cell(v){
    if(v===null) return '<span class="null">NULL</span>';
    if(typeof v==='object') return esc(JSON.stringify(v));
    return esc(v);
  }
  function show(out,res,ms,where){
    where=where||'play.clickhouse.com';
    if(res.raw!=null){ out.innerHTML='<pre class="raw">'+esc(res.raw)+'</pre><p class="foot">Elapsed: '+(ms/1000).toFixed(3)+' sec (round trip). Ran on play.clickhouse.com.</p>'; return; }
    var d=res.data, rows=d.data||[], more=rows.length>MAX_ROWS; if(more) rows=rows.slice(0,MAX_ROWS);
    var st=d.statistics||{};
    out.innerHTML='<div class="tbl"><table><thead><tr>'+d.meta.map(function(m){return '<th title="'+esc(m.type)+'">'+esc(m.name)+'</th>'}).join('')+'</tr></thead><tbody>'+
      (rows.map(function(r){return '<tr>'+r.map(function(v){return '<td>'+cell(v)+'</td>'}).join('')+'</tr>'}).join('')||'<tr><td colspan="'+d.meta.length+'" class="d">0 rows.</td></tr>')+
      '</tbody></table></div><p class="foot">'+(more?'Showing the first '+MAX_ROWS+' rows. ':rows.length+' row'+(rows.length===1?'':'s')+' in set. ')+
      'Elapsed: '+(st.elapsed!=null?st.elapsed:ms/1000).toFixed(3)+' sec.'+(st.rows_read!=null?' Processed '+st.rows_read.toLocaleString()+' rows.':'')+' Ran on '+where+'.</p>';
  }

  // run and edit sit outside the box, so pages that redraw the query don't wipe them
  function setup(box){
    var wrap=document.createElement('div'); wrap.className='qwrap';
    box.before(wrap); wrap.appendChild(box);
    var bar=document.createElement('div'); bar.className='runbar';
    var cloud=box.getAttribute('data-run')==='cloud';
    bar.innerHTML=cloud?'<button type="button" class="run" title="Run on ClickHouse Cloud">run</button><span class="where">on ClickHouse Cloud</span>'
      :'<button type="button" class="run" title="Run on play.clickhouse.com">run</button><button type="button" class="edit">edit</button>';
    wrap.appendChild(bar);
    var out=document.createElement('div'); out.className='result'; out.hidden=true;
    var status=document.createElement('span'); status.className='vh'; status.setAttribute('aria-live','polite');  // short announcements only
    wrap.after(out); out.after(status);
    var ta=null, runBtn=bar.querySelector('.run'), editBtn=bar.querySelector('.edit'), ctrl=null, runId=0;
    function finish(){ ctrl=null; runBtn.textContent='run'; runBtn.title=cloud?'Run on ClickHouse Cloud':'Run on play.clickhouse.com'; }
    // a Cloud box: the Worker runs this same fixed SQL with the box's one parameter, so visitors can't send their own
    function runCloud(mine,t0,id){
      out.innerHTML='<p class="foot">Running on ClickHouse Cloud…</p>';
      return fetch(box.getAttribute('data-api'),{signal:mine.signal}).then(function(r){ return r.json().then(function(j){
        if(id!==runId) return;
        if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
        var rows=j.results||[], cols=rows.length?Object.keys(rows[0]):['similarity','title','path'];
        show(out,{data:{meta:cols.map(function(c){return {name:c,type:''};}),data:rows.map(function(x){return cols.map(function(c){return x[c];});}),statistics:{}}},performance.now()-t0,'ClickHouse Cloud');
        var f=out.querySelector('.foot'); status.textContent=f?f.textContent:'Query finished';
      }); });
    }
    function run(){
      if(ctrl){ ctrl.abort(); return; }  // doubles as cancel
      var q=ta?ta.value:box.innerText, id=++runId, mine=new AbortController(); ctrl=mine;
      runBtn.textContent='cancel'; runBtn.title='Stop this query';
      out.hidden=false; out.innerHTML='<p class="foot">Running on play.clickhouse.com…</p>'; status.textContent='Running query';
      var t0=performance.now();
      (cloud?runCloud(mine,t0,id):build(q).then(function(b){
        var size=new TextEncoder().encode(b.sql).length;
        if(size>MAX_QUERY) throw new Error('Not sent. With the site\'s tables inside it, this query is '+Math.ceil(size/1024)+' KB, and play.clickhouse.com takes at most '+MAX_QUERY/1024+' KB (max_query_size). The site has outgrown the playground; query fewer of its tables.');
        return fetch(ENDPOINT,{method:'POST',body:b.sql,signal:mine.signal}).then(function(r){ return readCapped(r,mine).then(function(res){
          if(id!==runId) return;
          var ms=performance.now()-t0, text=res.text;
          // errors can arrive mid-stream after a 200
          var tail=/(?:^|\n)(Code: \d+\. DB::Exception[\s\S]*)$/.exec(text);
          if(!r.ok||(tail&&!res.cut&&!b.raw)) throw new Error(((tail&&tail[1])||text).trim()||('HTTP '+r.status));
          if(res.cut&&!b.raw) throw new Error('The result is over '+MAX_BYTES/1e6+' MB. Add a LIMIT and run it again.');
          show(out,b.raw?{raw:text+(res.cut?'\n… (stopped after '+MAX_BYTES/1e6+' MB)':'')}:{data:JSON.parse(text)},ms);
          var f=out.querySelector('.foot'); status.textContent=f?f.textContent:'Query finished';
        }); });
      })).catch(function(e){
        if(id!==runId) return;
        if(e&&e.name==='AbortError'){ out.innerHTML='<p class="foot">Cancelled.</p>'; status.textContent='Query cancelled'; return; }
        var msg=String(e&&e.message||e).replace(/\s*\(version [^()]*(\([^)]*\))?\)\s*$/,'');
        msg=msg.replace(/\. Expected one of: [\s\S]*?(\([A-Z_]+\))?$/,'. $1');  // drop the list of every possible token
        // ClickHouse echoes the inlined data; show the user's query instead
        msg=msg.replace(/failed at position \d+ \(([^)]*)\)(\s*\(line \d+, col \d+\))?: [\s\S]*?\. (\([A-Z_]+\))$/,'near "$1". $3');
        out.innerHTML='<pre class="err">'+esc(msg.length>600?msg.slice(0,600)+'…':msg)+'</pre>'; status.textContent='Query failed';
      }).then(function(){
        if(id!==runId) return;
        finish();
        if(out.querySelector('.clear')) return;
        var c=document.createElement('button'); c.type='button'; c.className='clear'; c.textContent='clear';
        c.addEventListener('click',function(){ out.hidden=true; out.innerHTML=''; status.textContent=''; });
        (out.querySelector('.foot')||out).appendChild(c);
      });
    }
    runBtn.addEventListener('click',run);
    if(editBtn) editBtn.addEventListener('click',function(){
      if(ta){ ta.remove(); ta=null; box.hidden=false; editBtn.textContent='edit'; return; }
      ta=document.createElement('textarea'); ta.className='query'; ta.spellcheck=false; ta.setAttribute('aria-label','SQL query');
      ta.value=box.innerText.replace(/^\s*:\)\s*/,'');
      var fit=function(){ ta.rows=Math.max(3,ta.value.split('\n').length+1); };
      fit(); ta.addEventListener('input',fit);
      ta.addEventListener('keydown',function(e){ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); if(!ctrl) run(); } });
      box.hidden=true; box.after(ta); ta.focus(); editBtn.textContent='reset';
    });
    // the talks filters say when a shown result is out of date
    box.addEventListener('query-changed',function(){ if(!ta&&!out.hidden&&!ctrl){ out.hidden=true; out.innerHTML=''; status.textContent=''; } });
    // data-auto: run once when it comes into view (Cloud boxes only, so play never sees a query nobody asked for)
    if(cloud&&box.hasAttribute('data-auto')){
      if(!('IntersectionObserver' in window)){ run(); return; }
      var seen=new IntersectionObserver(function(es){ if(es.some(function(e){ return e.isIntersecting; })){ seen.disconnect(); if(!ctrl&&out.hidden) run(); } },{rootMargin:'200px'});
      seen.observe(wrap);
    }
  }
  function init(){ document.querySelectorAll('.query[data-run]').forEach(setup); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
