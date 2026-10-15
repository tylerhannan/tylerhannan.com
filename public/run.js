// Makes the query boxes runnable against real ClickHouse (the public, read-only play.clickhouse.com).
// Boxes opt in with data-run. The site's own data is sent inline as CTEs (talks, photos, posts, pages),
// so `FROM talks` works; anything else on the playground (SHOW TABLES, its demo datasets) works too.
(function(){
  var ENDPOINT='https://play.clickhouse.com/?user=play';
  var MAX_ROWS=500;  // the playground allows far more; a browser table doesn't need it
  var esc=function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
  var json={};
  function load(url){ return json[url]||(json[url]=fetch(url).then(function(r){return r.json()})); }

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
    pages:function(){ return load('/archive/posts.json').then(function(d){
      var dec=function(v){ try{ return decodeURIComponent(v); }catch(_){ return v; } };
      var rows=[{path:'/',title:'Home'},{path:'/photos/',title:'Photos'},{path:'/archive/',title:'Writing archive'}].concat(d.posts||[]).map(function(p){ return {path:dec(p.path),title:p.title}; });
      return cte('pages','path String, title String',rows,['path','title']); }); }
  };

  function build(q){
    q=q.replace(/^\s*:\)\s*/,'').replace(/^(\s*--[^\n]*\n)+/,'').replace(/;\s*$/,'').trim();  // drop the prompt, leading -- comments and the final ;
    var names=Object.keys(TABLES).filter(function(n){return new RegExp('\\b'+n+'\\b','i').test(q)});
    var own=/\bFORMAT\s+\w+\s*$/i.test(q), select=/^(SELECT|WITH)\b/i.test(q);
    return Promise.all(names.map(function(n){return TABLES[n]()})).then(function(ctes){
      var pre=ctes.length?'WITH '+ctes.join(', ')+' ':'';
      if(own) return {sql:(select?pre:'')+q, raw:true};
      if(select) return {sql:pre+'SELECT * FROM ('+q+') LIMIT '+(MAX_ROWS+1)+' FORMAT JSONCompact'};
      return {sql:q+' FORMAT JSONCompact'};  // SHOW, DESCRIBE, EXPLAIN …
    });
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
    var out=document.createElement('div'); out.className='result'; out.hidden=true; out.setAttribute('aria-live','polite');
    wrap.after(out);
    var ta=null, runBtn=bar.querySelector('.run'), editBtn=bar.querySelector('.edit');
    function run(){
      var q=ta?ta.value:box.innerText;
      runBtn.disabled=true; runBtn.textContent='running…';
      out.hidden=false; out.innerHTML='<p class="foot">Running on play.clickhouse.com…</p>';
      var t0=performance.now();
      build(q).then(function(b){
        return fetch(ENDPOINT,{method:'POST',body:b.sql}).then(function(r){return r.text().then(function(text){
          var ms=performance.now()-t0;
          if(!r.ok) throw new Error(text.trim()||('HTTP '+r.status));
          show(out,b.raw?{raw:text}:{data:JSON.parse(text)},ms);
        })});
      }).catch(function(e){
        var msg=e.message.replace(/\s*\(version [^()]*(\([^)]*\))?\)\s*$/,'');
        msg=msg.replace(/\. Expected one of: [\s\S]*?(\([A-Z_]+\))?$/,'. $1');  // syntax errors list every possible token; drop it
        // ClickHouse echoes the query it saw, including the inlined site data; show the user's query instead
        msg=msg.replace(/failed at position \d+ \(([^)]*)\)(\s*\(line \d+, col \d+\))?: [\s\S]*?\. (\([A-Z_]+\))$/,'near "$1". $3');
        out.innerHTML='<pre class="err" role="alert">'+esc(msg.length>600?msg.slice(0,600)+'…':msg)+'</pre>';
      }).then(function(){
        runBtn.disabled=false; runBtn.textContent='▶ run';
        if(out.querySelector('.clear')) return;
        var c=document.createElement('button'); c.type='button'; c.className='clear'; c.textContent='clear';
        c.addEventListener('click',function(){ out.hidden=true; out.innerHTML=''; });
        (out.querySelector('.foot')||out).appendChild(c);
      });
    }
    runBtn.addEventListener('click',run);
    editBtn.addEventListener('click',function(){
      if(ta){ ta.remove(); ta=null; box.hidden=false; editBtn.textContent='edit'; return; }
      ta=document.createElement('textarea'); ta.className='query'; ta.spellcheck=false;
      ta.value=box.innerText.replace(/^\s*:\)\s*/,'');
      var fit=function(){ ta.rows=Math.max(3,ta.value.split('\n').length+1); };
      fit(); ta.addEventListener('input',fit);
      ta.addEventListener('keydown',function(e){ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); run(); } });
      box.hidden=true; box.after(ta); ta.focus(); editBtn.textContent='reset';
    });
  }
  function init(){ document.querySelectorAll('.query[data-run]').forEach(setup); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
