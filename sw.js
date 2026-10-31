/* StudyFlow: funciona sin conexión para la parte visual. Los datos vienen de Firebase. */
var CACHE='studyflow-fb-v41b-iconos';
var ASSETS=['./','./index.html','./firebase.js','./firebase-config.js','./manifest.json','./logo-192.png','./logo-512.png','./logo-maskable-512.png','./logo-apple-180.png','./logo-32.png'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(ASSETS)}));self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(x){return x!==CACHE}).map(function(x){return caches.delete(x)}))}));self.clients.claim()});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  var u=new URL(e.request.url);if(u.origin!==location.origin)return;
  // Red primero: así siempre llega la versión nueva; la caché solo sirve sin internet
  // Siempre pregunta al servidor (sin la copia de 10 minutos del navegador) para que la versión nueva llegue al instante
  var req=new Request(u.href,{cache:'no-cache',credentials:'same-origin'});
  e.respondWith(fetch(req).then(function(r){var c=r.clone();caches.open(CACHE).then(function(x){x.put(e.request,c)});return r}).catch(function(){return caches.match(e.request).then(function(h){return h||caches.match('./index.html')})}));
});
