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
  window.siteHref=function(u){ u=String(u||''); return /^(https?:\/\/|\/(?!\/))/i.test(u)?u:'#'; };  // links from data: web or site paths only
  window.siteAnchor={
    talk:function(t){ return '/#talk-'+slug(t.date+' '+t.event); },
    demo:function(d){ return '/#demo-'+slug(d.name); }
  };
})();
