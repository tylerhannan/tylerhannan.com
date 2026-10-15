// Makes the query boxes runnable against real ClickHouse (the public, read-only play.clickhouse.com).
// Boxes opt in with data-run. The site's own data is sent inline as CTEs (talks, photos, posts, pages),
// so `FROM talks` works; anything else on the playground (SHOW TABLES, its demo datasets) works too.
(function(){
  var ENDPOINT='https://play.clickhouse.com/?user=play';
  var MAX_ROWS=500;  // the playground allows far more; a browser table doesn't need it
  var MAX_BYTES=2e6; // and stop reading a response after ~2 MB, so a huge FORMAT TSV can't freeze the tab
  var esc=function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
  var json={};
  function load(url){  // cached per page; a failed fetch is forgotten so the next run retries
    return json[url]||(json[url]=fetch(url).then(function(r){ if(!r.ok) throw new Error(url+': HTTP '+r.status); return r.json(); })
      .catch(function(e){ delete json[url]; throw e; }));
  }

  // ---- the site's data as ClickHouse tables ----
  var day=function(d){ d=String(d||''); return d.length===4?d+'-01-01':d.length===7?d+'-01':d.slice(0,10); };
  var lit=function(v){ return typeof v==='boolean'?(v?'true':'false'):v==null||v===''&&v!==0?'NULL':typeof v==='number'?String(v):"'"+String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'"; };
  function cte(name,schema,rows,cols){
    var vals=rows.map(function(r){return '('+cols.map(function(c){return lit(r[c])}).join(', ')+')'}).join(', ');
    return name+' AS (SELECT * FROM values('+lit(schema)+', '+(vals||'')+'))';
  }
  var TABLES={
    talks:function(){ return load('/talks.json').then(function(d){
      var rows=(d.talks||[]).map(function(t){var o={};for(var k in t)o[k]=t[k];o.date=day(t.date);o.mc=!!t.mc;return o});
      return cte('talks','date Date, title String, event String, location Nullable(String), type String, url Nullable(String), youtube Nullable(String), repo Nullable(String), highlight Nullable(UInt8), note Nullable(String), mc Bool',
        rows,['date','title','event','location','type','url','youtube','repo','highlight','note','mc']); }); },
    photos:function(){ return load('/photos.json').then(function(d){
      var rows=(d.photos||[]).filter(function(p){return p.file}).map(function(p){var o={};for(var k in p)o[k]=p[k];o.date=day(p.date);return o});
      return cte('photos','date Date, file String, title String, place Nullable(String), camera Nullable(String), alt Nullable(String), focus Nullable(String)',
        rows,['date','file','title','place','camera','alt','focus']); }); },
    posts:function(){ return load('/archive/posts.json').then(function(d){
      var rows=(d.posts||[]).map(function(p){return {date:day(p.date),title:p.title,path:p.path}});
      return cte('posts','date Date, title String, path String',rows,['date','title','path']); }); },
    // every page on the site plus every talk, for the 404 page's "did you mean" query
    pages:function(){ return Promise.all([load('/archive/posts.json'),load('/talks.json')]).then(function(r){
      var dec=function(v){ try{ return decodeURIComponent(v); }catch(_){ return v; } };
      var rows=[{path:'/',title:'Home'},{path:'/photos/',title:'Photos'},{path:'/archive/',title:'Writing archive'}]
        .concat(r[0].posts||[]).map(function(p){ return {path:dec(p.path),title:p.title}; })
        .concat((r[1].talks||[]).map(function(t){ return {path:t.url||'https://www.youtube.com/watch?v='+t.youtube,title:t.title+' · '+t.event}; }));
      return cte('pages','path String, title String',rows,['path','title']); }); }
  };

  // Put the site tables in front of a query, merging with the query's own WITH if it has one.
  function withTables(ctes,q){
    if(!ctes.length) return q;
    return /^WITH\b/i.test(q) ? 'WITH '+ctes.join(', ')+', '+q.replace(/^WITH\s+/i,'') : 'WITH '+ctes.join(', ')+' '+q;
  }
  function build(q){
    q=q.replace(/^\s*:\)\s*/,'').replace(/;\s*$/,'');
    q=q.replace(/^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))+/,'').trim();  // leading comments
    var names=Object.keys(TABLES).filter(function(n){return new RegExp('\\b'+n+'\\b','i').test(q)});
    return Promise.all(names.map(function(n){return TABLES[n]()})).then(function(ctes){
      var own=/\bFORMAT\s+\w+\s*$/i.test(q), fmt=own?'':' FORMAT JSONCompact', m;
      if(/^(SELECT|WITH)\b/i.test(q))  // newlines keep a trailing -- comment from eating the wrapper
        return {sql: own ? withTables(ctes,q) : withTables(ctes,'SELECT * FROM (\n'+q+'\n) LIMIT '+(MAX_ROWS+1))+fmt, raw:own};
      if((m=q.match(/^(EXPLAIN(?:\s+(?:AST|SYNTAX|QUERY\s+TREE|PLAN|PIPELINE|ESTIMATE))?(?:\s+\w+\s*=\s*\w+(?:\s*,\s*\w+\s*=\s*\w+)*)?)\s+((?:SELECT|WITH)\b[\s\S]*)$/i)))
        return {sql: m[1]+' '+withTables(ctes,m[2])+fmt, raw:own};
      if((m=q.match(/^(DESC(?:RIBE)?)(?:\s+TABLE)?\s+(talks|photos|posts|pages)\s*$/i)))  // a site table isn't a real table
        return {sql: m[1]+' ('+withTables(ctes,'SELECT * FROM '+m[2].toLowerCase())+')'+fmt};
      return {sql:q+fmt, raw:own};  // SHOW, other DESCRIBE/EXPLAIN …
    });
  }

  // Read the response body, but no more than MAX_BYTES of it.
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
  function show(out,res,ms){
    if(res.raw!=null){ out.innerHTML='<pre class="raw">'+esc(res.raw)+'</pre><p class="foot">Elapsed: '+(ms/1000).toFixed(3)+' sec (round trip). Ran on play.clickhouse.com.</p>'; return; }
    var d=res.data, rows=d.data||[], more=rows.length>MAX_ROWS; if(more) rows=rows.slice(0,MAX_ROWS);
    var st=d.statistics||{};
    out.innerHTML='<div class="tbl"><table><thead><tr>'+d.meta.map(function(m){return '<th title="'+esc(m.type)+'">'+esc(m.name)+'</th>'}).join('')+'</tr></thead><tbody>'+
      (rows.map(function(r){return '<tr>'+r.map(function(v){return '<td>'+cell(v)+'</td>'}).join('')+'</tr>'}).join('')||'<tr><td colspan="'+d.meta.length+'" class="d">0 rows.</td></tr>')+
      '</tbody></table></div><p class="foot">'+(more?'Showing the first '+MAX_ROWS+' rows. ':rows.length+' row'+(rows.length===1?'':'s')+' in set. ')+
      'Elapsed: '+(st.elapsed!=null?st.elapsed:ms/1000).toFixed(3)+' sec.'+(st.rows_read!=null?' Processed '+st.rows_read.toLocaleString()+' rows.':'')+' Ran on play.clickhouse.com.</p>';
  }

  // UI: a quiet "▶ run · edit" in the box's top-right corner (outside the box element, so pages that
  // re-render the query text, like the talks filters, don't wipe it), and a compact result below.
  function setup(box){
    var wrap=document.createElement('div'); wrap.className='qwrap';
    box.before(wrap); wrap.appendChild(box);
    var bar=document.createElement('div'); bar.className='runbar';
    bar.innerHTML='<button type="button" class="run" title="Run on play.clickhouse.com">▶ run</button><button type="button" class="edit">edit</button>';
    wrap.appendChild(bar);
    var out=document.createElement('div'); out.className='result'; out.hidden=true;
    var status=document.createElement('span'); status.className='vh'; status.setAttribute('aria-live','polite');  // short announcements only
    wrap.after(out); out.after(status);
    var ta=null, runBtn=bar.querySelector('.run'), editBtn=bar.querySelector('.edit'), ctrl=null, runId=0;
    function finish(){ ctrl=null; runBtn.textContent='▶ run'; runBtn.title='Run on play.clickhouse.com'; }
    function run(){
      if(ctrl){ ctrl.abort(); return; }  // the button doubles as "cancel" while a query runs
      var q=ta?ta.value:box.innerText, id=++runId, mine=new AbortController(); ctrl=mine;
      runBtn.textContent='■ cancel'; runBtn.title='Stop this query';
      out.hidden=false; out.innerHTML='<p class="foot">Running on play.clickhouse.com…</p>'; status.textContent='Running query';
      var t0=performance.now();
      build(q).then(function(b){
        return fetch(ENDPOINT,{method:'POST',body:b.sql,signal:mine.signal}).then(function(r){ return readCapped(r,mine).then(function(res){
          if(id!==runId) return;
          var ms=performance.now()-t0, text=res.text;
          // errors can also arrive mid-stream after a 200, appended to the body
          var tail=/(?:^|\n)(Code: \d+\. DB::Exception[\s\S]*)$/.exec(text);
          if(!r.ok||(tail&&!res.cut&&!b.raw)) throw new Error(((tail&&tail[1])||text).trim()||('HTTP '+r.status));
          if(res.cut&&!b.raw) throw new Error('The result is over '+MAX_BYTES/1e6+' MB. Add a LIMIT and run it again.');
          show(out,b.raw?{raw:text+(res.cut?'\n… (stopped after '+MAX_BYTES/1e6+' MB)':'')}:{data:JSON.parse(text)},ms);
          var f=out.querySelector('.foot'); status.textContent=f?f.textContent:'Query finished';
        }); });
      }).catch(function(e){
        if(id!==runId) return;
        if(e&&e.name==='AbortError'){ out.innerHTML='<p class="foot">Cancelled.</p>'; status.textContent='Query cancelled'; return; }
        var msg=String(e&&e.message||e).replace(/\s*\(version [^()]*(\([^)]*\))?\)\s*$/,'');
        msg=msg.replace(/\. Expected one of: [\s\S]*?(\([A-Z_]+\))?$/,'. $1');  // syntax errors list every possible token; drop it
        // ClickHouse echoes the query it saw, including the inlined site data; show the user's query instead
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
    editBtn.addEventListener('click',function(){
      if(ta){ ta.remove(); ta=null; box.hidden=false; editBtn.textContent='edit'; return; }
      ta=document.createElement('textarea'); ta.className='query'; ta.spellcheck=false; ta.setAttribute('aria-label','SQL query');
      ta.value=box.innerText.replace(/^\s*:\)\s*/,'');
      var fit=function(){ ta.rows=Math.max(3,ta.value.split('\n').length+1); };
      fit(); ta.addEventListener('input',fit);
      ta.addEventListener('keydown',function(e){ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); if(!ctrl) run(); } });
      box.hidden=true; box.after(ta); ta.focus(); editBtn.textContent='reset';
    });
    // a page that rewrites this box's query (the talks filters) can say the shown result is now out of date
    box.addEventListener('query-changed',function(){ if(!ta&&!out.hidden&&!ctrl){ out.hidden=true; out.innerHTML=''; status.textContent=''; } });
  }
  function init(){ document.querySelectorAll('.query[data-run]').forEach(setup); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
