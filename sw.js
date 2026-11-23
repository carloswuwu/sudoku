/*
 * 数独 · Sudoku — Service Worker
 * 策略：网络优先，成功后更新缓存；离线时回退到缓存（导航请求回退到 index.html）。
 */
'use strict';

const CACHE_PREFIX = 'sudoku-offline-';
const CACHE_NAME = CACHE_PREFIX + 'v3';
const PRECACHE_URLS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'sudoku-core.js',
  'sudoku-hints.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'icon.ico'
];

/* 安装时绕过 HTTP 缓存，避免把旧版本的资源装进新缓存 */
const PRECACHE_REQUESTS = PRECACHE_URLS.map(function (url) {
  return new Request(new URL(url, self.registration.scope).href, { cache: 'reload' });
});

function offlineResponse(statusText) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>离线</title><p>当前离线，请稍后重试。</p>',
    { status: 503, statusText: statusText, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(PRECACHE_REQUESTS);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            /* 只清理本应用自己的缓存，不动同源其他应用 / 其他项目页面的缓存 */
            .filter(function (key) {
              return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(function (response) {
        if (!response || !response.ok) {
          /* 服务器返回错误时，优先用缓存里的好副本 */
          return caches.match(request).then(function (cached) {
            return cached || response || offlineResponse('Offline');
          });
        }
        /* 把缓存写入挂在 respondWith 的 promise 链上，确保 worker 不会被提前回收 */
        const copy = response.clone();
        return caches
          .open(CACHE_NAME)
          .then(function (cache) {
            return cache.put(request, copy);
          })
          .catch(function () {
            /* 缓存写入失败不影响正常返回 */
          })
          .then(function () {
            return response;
          });
      })
      .catch(function () {
        return caches.match(request).then(function (cached) {
          if (cached) return cached;
          if (request.mode === 'navigate') {
            return caches.match(new URL('index.html', self.registration.scope).href).then(function (index) {
              return index || offlineResponse('Offline');
            });
          }
          return new Response('', { status: 503, statusText: 'Offline' });
        });
      })
  );
});
