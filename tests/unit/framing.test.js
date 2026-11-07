import test from 'node:test';
import assert from 'node:assert/strict';
import { LspFramer, encodeMessage } from '../../src/lsp/framing.js';

function collect(chunks, options = {}) {
  const messages = [];
  const errors = [];
  const framer = new LspFramer({
    onMessage: (m) => messages.push(m),
    onError: (e) => errors.push(e),
    ...options,
  });
  for (const chunk of chunks) framer.push(chunk);
  return { messages, errors };
}

test('encodeMessage 的 Content-Length 按 UTF-8 字节计', () => {
  const encoded = encodeMessage({ id: 1, text: '中文' });
  const text = encoded.toString('utf8');
  const [header, body] = text.split('\r\n\r\n');
  assert.match(header, /^Content-Length: \d+$/);
  const declared = Number(header.slice('Content-Length: '.length));
  assert.equal(declared, Buffer.byteLength(body, 'utf8'));
  assert.ok(declared > body.length, '中文字节数应大于字符数');
  assert.deepEqual(JSON.parse(body), { id: 1, text: '中文' });
});

test('一个 chunk 里多条消息按序解析', () => {
  const a = encodeMessage({ id: 1 });
  const b = encodeMessage({ id: 2 });
  const { messages, errors } = collect([Buffer.concat([a, b])]);
  assert.equal(errors.length, 0);
  assert.deepEqual(messages, [{ id: 1 }, { id: 2 }]);
});

test('消息跨 chunk 时等待剩余字节', () => {
  const full = encodeMessage({ id: 7, payload: 'hello world' });
  const { messages, errors } = collect([full.subarray(0, 10), full.subarray(10, 25), full.subarray(25)]);
  assert.equal(errors.length, 0);
  assert.deepEqual(messages, [{ id: 7, payload: 'hello world' }]);
});

test('缺少 Content-Length 报错', () => {
  const { messages, errors } = collect([Buffer.from('X-Test: 1\r\n\r\n{}')]);
  assert.equal(messages.length, 0);
  assert.match(errors[0].message, /Content-Length/);
});

test('非法 header 行报错', () => {
  const { errors } = collect([Buffer.from('BadHeader\r\n\r\n{}')]);
  assert.match(errors[0].message, /非法 header 行/);
});

test('body 超过 maxBodyBytes 报错', () => {
  const full = encodeMessage({ id: 1 });
  const { errors } = collect([full], { maxBodyBytes: 4 });
  assert.match(errors[0].message, /超过上限/);
});

test('body 不是合法 JSON 时只报错并继续解析后续消息', () => {
  const bad = Buffer.from('Content-Length: 3\r\n\r\nxxx');
  const good = encodeMessage({ id: 9 });
  const { messages, errors } = collect([Buffer.concat([bad, good])]);
  assert.equal(errors.length, 1);
  assert.deepEqual(messages, [{ id: 9 }]);
});
