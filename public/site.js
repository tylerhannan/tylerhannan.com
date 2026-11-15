// Every page loads this in <head> so a saved light theme applies before first paint.
// Also: the contact copy button, and siteAnchor, the home-page link that opens a talk or demo row.
(function(){
  var root=document.documentElement;
  try{ if(localStorage.getItem('theme')==='light') root.dataset.theme='light'; }catch(_){}
  function label(){
    var light=root.dataset.theme==='light';
    var tc=document.querySelector('meta[name="theme-color"]'); if(tc) tc.content=light?'#ffffff':'#181818';  // browser bar matches
    document.querySelectorAll('.theme').forEach(function(b){
      b.textContent=light?'☾ dark':'☀ light';
      b.setAttribute('aria-label','Switch to '+(light?'dark':'light')+' mode');
    });
  }
  document.addEventListener('click',function(e){
    if(!e.target.closest('.theme')) return;
    var light=root.dataset.theme!=='light';
    if(light) root.dataset.theme='light'; else delete root.dataset.theme;
    try{ localStorage.setItem('theme',light?'light':'dark'); }catch(_){}
    label();
  });
  document.addEventListener('DOMContentLoaded',label);

  document.addEventListener('click',function(e){
    var b=e.target.closest('#copy'); if(!b) return;
    var el=document.getElementById('email');
    var done=function(){b.textContent='copied';setTimeout(function(){b.textContent='copy'},1500)};
    function sel(){var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r);}
    try{ navigator.clipboard.writeText(el.textContent).then(done,sel); }catch(_){ sel(); }
  });

  var slug=function(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); };
  // links from data: web or site paths only; browsers drop tabs and newlines and read \ as /, so refuse them
  window.siteHref=function(u){ u=String(u||''); return !/[\s\\]/.test(u)&&/^(https?:\/\/|\/(?!\/))/i.test(u)?u:'#'; };
  window.siteAnchor={
    talk:function(t){ return '/#talk-'+slug(t.date+' '+t.event); },
    demo:function(d){ return '/#demo-'+slug(d.name); }
  };
  // the pages table's rows, shared by run.js and search.js; k is the vector's key
  window.sitePageRows=function(posts,talks,demos,photos,writing){
    var dec=function(v){ try{ return decodeURIComponent(v); }catch(_){ return v; } };
    var row=function(path,title,k,event){ return {path:path,title:title,k:k,event:event||null}; };
    return [{path:'/',title:'Home'},{path:'/photos/',title:'Photos'},{path:'/archive/',title:'Writing archive'}].concat(posts.posts||[])
      .map(function(p){ return row(dec(p.path),p.title,p.path); })
      // talks and demos live on the home page; their vectors are keyed by their own link
      .concat((talks.talks||[]).map(function(t){ return row(window.siteAnchor.talk(t),t.title+' · '+t.event,t.url||'https://www.youtube.com/watch?v='+t.youtube,t.event); }))
      .concat((demos.demos||[]).map(function(d){ return row(window.siteAnchor.demo(d),d.name+' · demo',d.repo); }))
      // opens the photo in the viewer
      .concat((photos.photos||[]).filter(function(p){ return p.file; }).map(function(p){ return row('/photos/#'+p.file.replace(/\.[^.]+$/,''),p.title+' · photo','/photos/'+p.file); }))
      .concat((writing.writing||[]).map(function(w){ return row(w.url,w.title+' · '+w.venue,w.url); }));
  };
})();
