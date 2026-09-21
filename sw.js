// EyraLab — service worker.
// Цель: второй заход на сайт не качает ничего заново. Постеры, логотипы, шрифты и облёт
// лежат в Cache Storage; каждый просмотренный ролик остаётся прогруженным навсегда.
// Версию и список хэшей подставляет build.py — руками не править, правится здесь, собирается в «Готовый сайт/sw.js».

const VER = 'ea757eb8b06d';                    // хэш сборки: меняется — статика перекачивается
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
  // Облёт с 21.09 перематывается по блобу в памяти страницы, а не через сеть, поэтому посредник на
  // этом пути больше никому не мешает — и наоборот, нужен: из кэша блоб берётся без второй загрузки.
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
// Схема нарочно тупая и безопасная (20.09, вечер).
// Было: сетевой поток раздваивался — половина в плеер, половина в кэш. Одна загрузка, но у tee общий
// темп: кэш пишет на диск медленно — плеер ждёт его. На тяжёлых роликах это вешало воспроизведение,
// а оборванная запись могла лечь в кэш огрызком и отдаваться вместо ролика.
// Стало: плеер ВСЕГДА идёт в сеть напрямую, воркер в его поток не лезет. Файл попадает в кэш отдельной
// фоновой загрузкой, по одному и с задержкой, чтобы не мешать первому экрану. В кэш кладётся только
// целый файл (длина сверяется), а на отдаче размер проверяется ещё раз — огрызок не переживёт чтения.

const WARM_DELAY = 5000;      // не лезем в сеть, пока рисуется первый экран
// Облёт перематывается скроллом — это десятки Range-запросов в секунду. Открывать кэш и читать Blob
// на каждый из них нельзя: задержка растягивает перемотку и Chrome дольше держит readyState=1.
// Поэтому Blob запоминается в памяти воркера, и дальше запрос — это только blob.slice().
const hot = new Map();        // pathname -> {blob, type}
const warming = new Set();
let chain = Promise.resolve();
function queue(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

function parseRange(h, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(h || '');
  if (!m) return null;
  let s = m[1] === '' ? null : +m[1];
  let e = m[2] === '' ? null : +m[2];
  if (s === null) { if (e === null) return null; s = Math.max(0, size - e); e = size - 1; }
  else if (e === null || e >= size) e = size - 1;
  return s > e ? null : { s, e };
}

function slice(blob, type, rangeHeader) {
  const size = blob.size;
  if (!rangeHeader) return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  const r = parseRange(rangeHeader, size);
  if (!r) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  return new Response(blob.slice(r.s, r.e + 1), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(r.e - r.s + 1),
      'Content-Range': 'bytes ' + r.s + '-' + r.e + '/' + size,
      'Accept-Ranges': 'bytes'
    }
  });
}

async function media(e, req, url, path) {
  const key = url.pathname;
  const rh = req.headers.get('range');
  let h = hot.get(key);
  if (!h) {
    const c = await caches.open(MEDIA);
    const hit = await c.match(key, { ignoreVary: true });
    if (hit) {
      const want = Number(hit.headers.get('x-len') || 0);
      const blob = await hit.blob();
      if (want && blob.size === want) {
        h = { blob, type: hit.headers.get('Content-Type') || 'video/mp4' };
        hot.set(key, h);
      } else {
        await c.delete(key);            // огрызок — выкинули, дальше как будто его и не было
      }
    }
  }
  if (h) return slice(h.blob, h.type, rh);
  e.waitUntil(queue(() => warm(key, path)));
  return fetch(req);                    // плеер получает ответ сети как есть, без посредников
}

async function warm(key, path) {
  const c = await caches.open(MEDIA);
  if (warming.has(key)) return;
  if (await c.match(key, { ignoreVary: true })) return;
  warming.add(key);
  try {
    await new Promise(r => setTimeout(r, WARM_DELAY));
    const r = await fetch(key);
    if (r.status !== 200) return;
    const buf = await r.arrayBuffer();
    const len = Number(r.headers.get('Content-Length') || 0);
    if (len && buf.byteLength !== len) return;                 // оборвалось на полпути — не кэшируем
    const type = r.headers.get('Content-Type') || (/\.webm$/i.test(path) ? 'video/webm' : 'video/mp4');
    await c.put(key, new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(buf.byteLength),
        'Accept-Ranges': 'bytes',
        'x-eyra': MANIFEST[path] || '',
        'x-len': String(buf.byteLength)
      }
    }));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') { try { await caches.delete(MEDIA); } catch (x) {} }
    else { try { await c.delete(key); } catch (x) {} }
  } finally {
    warming.delete(key);
  }
}
