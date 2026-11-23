/*
 * Service Worker 单元测试（不依赖浏览器）：node tests/sw.test.js
 * 用最小的 self / caches / fetch 桩执行 sw.js，验证缓存作用域与离线回退。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SW_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const SCOPE = 'http://localhost/sudoku/';
const CACHE_NAME = 'sudoku-offline-v3';

let passed = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    passed++;
  } else {
    failures.push(message);
    console.log('  ✗ ' + message);
  }
}

function eq(actual, expected, message) {
  ok(actual === expected, message + '  (期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + ')');
}

function networkResponse(body, status) {
  return new Response(body, { status: status || 200, headers: { 'Content-Type': 'text/plain' } });
}

function absolute(url) {
  return new URL(url, SCOPE).href;
}

function makeCache(store) {
  function add(request) {
    const key = typeof request === 'string' ? absolute(request) : request.url;
    store.set(key, networkResponse('asset ' + key));
    return Promise.resolve();
  }
  return {
    addAll(requests) {
      return Promise.all(Array.from(requests).map(add));
    },
    add,
    put(request, response) {
      store.set(request.url, response.clone());
      return Promise.resolve();
    },
  };
}

function createHarness(options) {
  options = options || {};
  const listeners = {};
  const stores = new Map();
  const state = { skippedWaiting: false, claimed: false, fetched: [] };

  const caches = {
    open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      return Promise.resolve(makeCache(stores.get(name)));
    },
    keys() {
      return Promise.resolve(Array.from(stores.keys()));
    },
    delete(name) {
      return Promise.resolve(stores.delete(name));
    },
    match(request) {
      const url = typeof request === 'string' ? request : request.url;
      for (const store of stores.values()) {
        if (store.has(url)) return Promise.resolve(store.get(url).clone());
      }
      return Promise.resolve(undefined);
    },
  };

  const context = {
    self: {
      addEventListener(type, listener) {
        listeners[type] = listener;
      },
      skipWaiting() {
        state.skippedWaiting = true;
        return Promise.resolve();
      },
      clients: {
        claim() {
          state.claimed = true;
          return Promise.resolve();
        },
      },
      registration: { scope: SCOPE },
      location: { origin: 'http://localhost' },
    },
    caches,
    URL,
    Request,
    Response,
    fetch: function (request) {
      state.fetched.push(request);
      if (options.fetch) return options.fetch(request);
      return Promise.reject(new Error('offline'));
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context, { filename: 'sw.js' });

  return { listeners, stores, state, caches };
}

function dispatch(harness, type, event) {
  const listener = harness.listeners[type];
  if (!listener) throw new Error('缺少 ' + type + ' 监听器');
  listener(event);
  return event;
}

function makeFetchEvent(request) {
  const event = {
    request,
    responded: false,
    respondWith(promise) {
      this.responded = true;
      this.promise = promise;
    },
    waitUntil() {},
  };
  return event;
}

function getRequest(url, mode) {
  return { method: 'GET', url: absolute(url), mode: mode || 'no-cors' };
}

async function main() {
  console.log('Service Worker 测试');

  console.log('\n[1] install 预缓存');
  {
    const harness = createHarness();
    const event = { waitUntil(promise) { this.promise = promise; } };
    dispatch(harness, 'install', event);
    await event.promise;
    const store = harness.stores.get(CACHE_NAME);
    ok(!!store, '创建当前版本缓存 ' + CACHE_NAME);
    eq(store ? store.size : 0, 12, '预缓存全部 12 个资源');
    ok(!!store && store.has(absolute('icon-maskable-512.png')), '预缓存包含 maskable 图标（icon-maskable-512.png）');
    ok(harness.state.skippedWaiting, '安装完成后调用 skipWaiting');
  }

  console.log('\n[2] activate 只清理本应用旧缓存');
  {
    const harness = createHarness();
    harness.stores.set('sudoku-offline-v1', new Map([[absolute('old.css'), networkResponse('old')]]));
    harness.stores.set('other-app-cache', new Map([[absolute('other.js'), networkResponse('other')]]));
    harness.stores.set(CACHE_NAME, new Map());
    const event = { waitUntil(promise) { this.promise = promise; } };
    dispatch(harness, 'activate', event);
    await event.promise;
    ok(!harness.stores.has('sudoku-offline-v1'), '删除本应用的旧版本缓存');
    ok(harness.stores.has('other-app-cache'), '保留同源其他应用的缓存');
    ok(harness.stores.has(CACHE_NAME), '保留当前版本缓存');
    ok(harness.state.claimed, '激活后调用 clients.claim()');
  }

  console.log('\n[3] fetch：在线响应写入缓存');
  {
    const harness = createHarness({ fetch: () => Promise.resolve(networkResponse('fresh')) });
    const request = getRequest('app.js');
    const event = dispatch(harness, 'fetch', makeFetchEvent(request));
    ok(event.responded, 'GET 请求交给 respondWith 处理');
    const response = await event.promise;
    eq(await response.text(), 'fresh', '在线时返回网络响应');
    const cached = await harness.caches.match(request);
    ok(!!cached, '在线响应写入运行时缓存');
    eq(cached && cached.status, 200, '缓存副本状态码为 200');
  }

  console.log('\n[4] fetch：网络失败时回退缓存');
  {
    const harness = createHarness();
    const request = getRequest('app.js');
    harness.stores.set(CACHE_NAME, new Map([[request.url, networkResponse('cached')]]));
    const event = dispatch(harness, 'fetch', makeFetchEvent(request));
    const response = await event.promise;
    eq(await response.text(), 'cached', '断网时返回缓存内容');
    eq(response.status, 200, '断网回退响应可用');
  }

  console.log('\n[5] fetch：服务器返回错误时优先用缓存');
  {
    const harness = createHarness({ fetch: () => Promise.resolve(networkResponse('server error', 500)) });
    const request = getRequest('app.js');
    harness.stores.set(CACHE_NAME, new Map([[request.url, networkResponse('cached')]]));
    const event = dispatch(harness, 'fetch', makeFetchEvent(request));
    const response = await event.promise;
    eq(await response.text(), 'cached', '500 时改用缓存的好副本');
    eq(response.status, 200, '返回缓存状态码');
  }

  console.log('\n[6] fetch：离线导航回退到 index.html');
  {
    const harness = createHarness();
    harness.stores.set(CACHE_NAME, new Map([[absolute('index.html'), networkResponse('index page')]]));
    const event = dispatch(harness, 'fetch', makeFetchEvent(getRequest('deep/link', 'navigate')));
    const response = await event.promise;
    eq(await response.text(), 'index page', '离线深层链接回退到应用外壳');
    eq(response.status, 200, '导航回退响应可用');
  }

  console.log('\n[7] fetch：离线且无缓存时返回 503');
  {
    const harness = createHarness();
    const navigateEvent = dispatch(harness, 'fetch', makeFetchEvent(getRequest('missing', 'navigate')));
    const navigateResponse = await navigateEvent.promise;
    eq(navigateResponse.status, 503, '导航无缓存时返回 503');

    const assetEvent = dispatch(harness, 'fetch', makeFetchEvent(getRequest('missing.js')));
    const assetResponse = await assetEvent.promise;
    eq(assetResponse.status, 503, '资源无缓存时返回 503');
  }

  console.log('\n[8] fetch：非 GET 与跨域请求不接管');
  {
    const harness = createHarness();
    const postEvent = makeFetchEvent({ method: 'POST', url: absolute('app.js'), mode: 'no-cors' });
    dispatch(harness, 'fetch', postEvent);
    ok(!postEvent.responded, 'POST 请求交给浏览器默认处理');

    const crossEvent = makeFetchEvent({ method: 'GET', url: 'http://example.com/x.js', mode: 'no-cors' });
    dispatch(harness, 'fetch', crossEvent);
    ok(!crossEvent.responded, '跨域请求交给浏览器默认处理');
  }

  console.log('\n结果：' + passed + ' 项通过，' + failures.length + ' 项失败');
  if (failures.length) {
    console.log('\n失败项：\n- ' + failures.join('\n- '));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n测试异常终止：', err);
  process.exitCode = 1;
});
