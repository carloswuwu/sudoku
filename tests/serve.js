/* 本地静态服务器（开发测试用）：node tests/serve.js，默认 http://127.0.0.1:8099/sudoku/ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8099);
const PREFIX = '/sudoku/';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http
  .createServer(function (req, res) {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (err) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    if (!urlPath.startsWith(PREFIX)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let rel = urlPath.slice(PREFIX.length);
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, rel);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(file, function (err, data) {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', function () {
    console.log('serving http://127.0.0.1:' + PORT + PREFIX);
  });
