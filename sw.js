// EyraLab — service worker.
// Цель: второй заход на сайт не качает ничего заново. Постеры, логотипы, шрифты и облёт
// лежат в Cache Storage; каждый просмотренный ролик остаётся прогруженным навсегда.
// Версию и список хэшей подставляет build.py — руками не править, правится здесь, собирается в «Готовый сайт/sw.js».

const VER = '5655e1d7dd37';                    // хэш сборки: меняется — статика перекачивается
const STATIC = 'eyra-static-' + VER;
const MEDIA  = 'eyra-media';              // переживает пересборку; ролики сверяются по хэшу файла
const MANIFEST = {"assets/loopA.mp4": "1adc6fd39f0e", "assets/loopA.webm": "ced00ed78b10", "assets/loopC.mp4": "f3345abb7588", "assets/loopC.webm": "4e9c463a69e0", "assets/scrub.mp4": "1d082519b397", "assets/scrub.webm": "2a32b6a5d510", "видео/acvelon.mp4": "ecdab3f65c89", "видео/bigroup.mp4": "51d0a7320523", "видео/cops.mp4": "d1e4525a005e", "видео/cu.mp4": "20b4484df743", "видео/dos.mp4": "57a74245e717", "видео/eito.mp4": "e9c43a461226", "видео/ellai.mp4": "c66b8e176c59", "видео/esenin.mp4": "83568cd0f022", "видео/girl.mp4": "19d23300194f", "видео/halykbank.mp4": "5b11146a986c", "видео/halyklife.mp4": "964661567d27", "видео/jack.mp4": "37fd1739b07c", "видео/kurozu.mp4": "c9ea253de5de", "видео/mediabasket.mp4": "a7a9df77dfa5", "видео/moreart.mp4": "c9214186679c", "видео/mycar.mp4": "db2c4ae5c1df", "видео/nauryz.mp4": "d92b4a4b1a73", "видео/nia.mp4": "26519688111c", "видео/otty.mp4": "6ef87994e907", "видео/parkville.mp4": "81174044b7b8", "видео/stroitel.mp4": "0596f0f308fa", "видео/xokky.mp4": "424c59078102"};            // 'видео/girl.mp4' -> хэш содержимого

const SCOPE = new URL(self.registration.scope).pathname;
const rel = p => decodeURIComponent(p.startsWith(SCOPE) ? p.slice(SCOPE.length) : p.replace(/^\/+/, ''));
const isMedia = p => /\.(mp4|webm)$/i.test(p);

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => e.waitUntil((async () => {
  // старые версии статики — за борт
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('eyra-static-') && k !== STATIC).map(k => caches.delete(k)));
  // ролик, который пересняли, выкидываем из кэша — остальные остаются лежать
  const c = await caches.open(MEDIA);
  for (const req of await c.keys()) {
    const path = rel(new URL(req.url).pathname);
    const hit = await c.match(req, { ignoreVary: true });
    if (!MANIFEST[path] || !hit || hit.headers.get('x-eyra') !== MANIFEST[path]) await c.delete(req);
  }
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = rel(url.pathname);
  if (isMedia(path)) return e.respondWith(media(e, req, url, path));
  if (path === '' || path === 'index.html') return e.respondWith(page(req));
  e.respondWith(asset(req));
});

// index.html — всегда из сети (иначе после публикации останется старая страница), кэш на случай офлайна
async function page(req) {
  const c = await caches.open(STATIC);
  try {
    const r = await fetch(req);
    if (r.ok) c.put(req, r.clone()).catch(() => {});
    return r;
  } catch (err) {
    const hit = await c.match(req, { ignoreVary: true }) || await c.match(SCOPE + 'index.html', { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

// assets/, постеры, og.jpg — сначала кэш. Имена стабильные, поэтому свежесть держится версией кэша.
async function asset(req) {
  const c = await caches.open(STATIC);
  const hit = await c.match(req, { ignoreVary: true });
  if (hit) return hit;
  const r = await fetch(req);
  if (r.status === 200 && r.type === 'basic') c.put(req, r.clone()).catch(() => {});
  return r;
}

// ——— видео ———
// Плеер просит файл кусками (Range). Из кэша куски нарезаются Blob.slice — без чтения файла в память.
function parseRange(h, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(h || '');
  if (!m) return null;
  let s = m[1] === '' ? null : +m[1];
  let e = m[2] === '' ? null : +m[2];
  if (s === null) { if (e === null) return null; s = Math.max(0, size - e); e = size - 1; }
  else if (e === null || e >= size) e = size - 1;
  return s > e ? null : { s, e };
}

async function fromCache(res, rangeHeader) {
  if (!rangeHeader) return res;
  const blob = await res.blob();
  const size = blob.size;
  const r = parseRange(rangeHeader, size);
  if (!r) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  return new Response(blob.slice(r.s, r.e + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'video/mp4',
      'Content-Length': String(r.e - r.s + 1),
      'Content-Range': 'bytes ' + r.s + '-' + r.e + '/' + size,
      'Accept-Ranges': 'bytes'
    }
  });
}

async function media(e, req, url, path) {
  const c = await caches.open(MEDIA);
  const key = url.pathname;
  const hit = await c.match(key, { ignoreVary: true });
  const rh = req.headers.get('range');
  if (hit) return fromCache(hit, rh);

  // перемотка вперёд до того, как файл лёг в кэш — отдаём сети, кэш не трогаем
  const m = /bytes=(\d*)-/.exec(rh || '');
  const start = m ? (m[1] === '' ? -1 : +m[1]) : 0;
  if (start !== 0) return fetch(req);

  let net;
  try { net = await fetch(key); } catch (err) { return fetch(req); }
  if (net.status !== 200 || !net.body) return net;

  const size = Number(net.headers.get('Content-Length') || 0);
  const type = net.headers.get('Content-Type') || (/\.webm$/i.test(path) ? 'video/webm' : 'video/mp4');
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  if (size) head['Content-Length'] = String(size);

  // одна загрузка из сети: одна копия идёт в плеер, вторая — в кэш
  const [toCache, toClient] = net.body.tee();
  e.waitUntil(store(c, key, new Response(toCache, {
    status: 200, headers: Object.assign({ 'x-eyra': MANIFEST[path] || '' }, head)
  }), size));

  if (!rh) return new Response(toClient, { status: 200, headers: head });
  const h = Object.assign({}, head);
  if (size) h['Content-Range'] = 'bytes 0-' + (size - 1) + '/' + size;
  return new Response(toClient, { status: 206, headers: h });
}

async function store(c, key, res, size) {
  try {
    await c.put(key, res);
    if (size) {                                  // оборванную закачку в кэше не держим
      const back = await c.match(key, { ignoreVary: true });
      const blob = back && await back.blob();
      if (!blob || blob.size !== size) await c.delete(key);
    }
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') { try { await caches.delete(MEDIA); } catch (x) {} }
    else { try { await c.delete(key); } catch (x) {} }
  }
}
