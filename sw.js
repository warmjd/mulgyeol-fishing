/* 물결마을: 앱처럼 설치되게 하는 최소 서비스 워커 (캐시 없이 늘 최신 버전) */
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { if (e.request.method !== 'GET') return; e.respondWith(fetch(e.request).catch(() => new Response('<meta charset=utf8><body style="font-family:sans-serif;text-align:center;padding:40px;background:#cfe8d8">🌊 인터넷이 끊겼어요. 연결되면 다시 열어 주세요!</body>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))); });
