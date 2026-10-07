// Dark by default. The header button switches to light and remembers the choice.
// Loaded in <head> (not deferred) so a saved light theme applies before first paint.
(function(){
  var root=document.documentElement;
  try{ if(localStorage.getItem('theme')==='light') root.dataset.theme='light'; }catch(_){}
  function label(){
    var light=root.dataset.theme==='light';
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
})();
