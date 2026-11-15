/*
 * 数独 · Sudoku — Service Worker
 * 策略：网络优先，成功后更新缓存；离线时回退到缓存（导航请求回退到 index.html）。
 */
'use strict';

const CACHE_NAME = 'sudoku-offline-v2';
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
  'apple-touch-icon.png',
  'icon.ico'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(PRECACHE_URLS);
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
            .filter(function (key) {
              return key !== CACHE_NAME;
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
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, copy).catch(function () {});
          });
        }
        return response;
      })
      .catch(function () {
        return caches.match(request).then(function (cached) {
          if (cached) return cached;
          if (request.mode === 'navigate') {
            return caches.match(new URL('index.html', self.registration.scope).href);
          }
          return new Response('', { status: 503, statusText: 'Offline' });
        });
      })
  );
});
