// Shared by every page. Loaded in <head> (not deferred) so a saved light theme applies before first paint.
// Theme: dark by default; the header button switches to light and remembers the choice.
// Contact: the copy button next to the email address.
// siteAnchor: each talk's and demo's link on the home page, which opens that row. Search results and the 404
// page link there, so they stay on this site: /#talk-<date>-<event>, /#demo-<name>.
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
  window.siteAnchor={
    talk:function(t){ return '/#talk-'+slug(t.date+' '+t.event); },
    demo:function(d){ return '/#demo-'+slug(d.name); }
  };
})();
