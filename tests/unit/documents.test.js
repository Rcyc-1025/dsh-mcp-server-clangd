import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DocumentStore } from '../../src/lsp/documents.js';

function fakeClient() {
  const client = new EventEmitter();
  client.notifications = [];
  client.cleared = [];
  client.notify = (method, params) => client.notifications.push({ method, params });
  client.clearDiagnostics = (uri) => client.cleared.push(uri);
  return client;
}

function fakeLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  const client = fakeClient();
  const config = { maxFileBytes: 1024 * 1024, maxOpenDocuments: 16, ...overrides };
  const store = new DocumentStore({ config, client, logger: fakeLogger() });
  return { dir, client, store };
}

function write(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return { file, uri: pathToFileURL(file).href };
}

test('didOpen 前后清空旧诊断，内容未变不重复 didOpen', async () => {
  const { dir, client, store } = setup();
  const { file, uri } = write(dir, 'a.cpp', 'int a;\n');
  const doc = await store.ensure(file, uri);
  assert.equal(doc.version, 1);
  assert.deepEqual(client.notifications.map((n) => n.method), ['textDocument/didOpen']);
  assert.deepEqual(client.cleared, [uri]);

  const again = await store.ensure(file, uri);
  assert.equal(again.version, 1);
  assert.equal(client.notifications.length, 1);
  assert.equal(client.cleared.length, 1);
});

test('内容变化 didChange 升版本并清空旧诊断', async () => {
  const { dir, client, store } = setup();
  const { file, uri } = write(dir, 'b.cpp', 'int b;\n');
  await store.ensure(file, uri);

  fs.writeFileSync(file, 'int b = 2;\n');
  const changed = await store.ensure(file, uri);
  assert.equal(changed.version, 2);
  const change = client.notifications.find((n) => n.method === 'textDocument/didChange');
  assert.equal(change.params.textDocument.version, 2);
  assert.equal(client.cleared.filter((u) => u === uri).length, 2);
});

test('clangd 退出后 forgetAll：再次 ensure 重新 didOpen（version 回到 1）', async () => {
  const { dir, client, store } = setup();
  const { file, uri } = write(dir, 'c.cpp', 'int c;\n');
  await store.ensure(file, uri);
  assert.equal(store.size, 1);

  client.emit('exit', 1, null);
  assert.equal(store.size, 0);
  assert.equal(client.cleared.filter((u) => u === uri).length, 1);

  const reopened = await store.ensure(file, uri);
  assert.equal(reopened.version, 1);
  const opens = client.notifications.filter((n) => n.method === 'textDocument/didOpen');
  assert.equal(opens.length, 2);
});

test('LRU 淘汰时 didClose 并清空被淘汰文档的诊断', async () => {
  const { dir, client, store } = setup({ maxOpenDocuments: 1 });
  const a = write(dir, 'd.cpp', 'int d;\n');
  const b = write(dir, 'e.cpp', 'int e;\n');
  await store.ensure(a.file, a.uri);
  await store.ensure(a.file, a.uri);
  await store.ensure(b.file, b.uri);

  assert.equal(store.size, 1);
  assert.equal(store.versionOf(a.file), null);
  assert.ok(client.notifications.some((n) => n.method === 'textDocument/didClose' && n.params.textDocument.uri === a.uri));
  assert.ok(client.cleared.includes(a.uri));
});
