const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const base = class {};
const calls = []; let status = 201;
const ob = { Plugin: base, ItemView: base, MarkdownView: base, MarkdownRenderChild: base, PluginSettingTab: base, Modal: base, normalizePath: x => x, requestUrl: async o => { calls.push(o); return { status }; } };
const ctx = { module: { exports: {} }, require: () => ob, URL, TextEncoder, crypto: crypto.webcrypto, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(__dirname + '/main.js', 'utf8') + '\nObject.assign(module.exports, { uploadCloudFile, cloudCreateFolder, cloudMove, cloudDelete, cloudChild });', ctx);
const upload = ctx.module.exports.uploadCloudFile;
const win = { crypto: crypto.webcrypto, TextEncoder, btoa: s => Buffer.from(s, 'binary').toString('base64') };
const bytes = Uint8Array.from([0, 255, 42]).buffer;
const file = { name: '中文 #封面.png', type: 'image/png', size: 3, arrayBuffer: async () => bytes };
async function run() {
  const dav = { provider: 'webdav', endpoint: 'https://dav.test/media/', username: 'user', password: 'secret' };
  const name = await upload(dav, 'https://dav.test/media/子目录/', file, win);
  const d = calls.at(-1); assert.equal(d.method, 'PUT'); assert.equal(d.body, bytes); assert.equal(d.headers['If-None-Match'], '*'); assert.equal(d.headers.Authorization, 'Basic dXNlcjpzZWNyZXQ=');
  assert.equal(decodeURIComponent(new URL(d.url).pathname), '/media/子目录/' + name);
  await assert.rejects(upload(dav, 'https://other.test/', file, win));
  await assert.rejects(upload(dav, 'https://dav.test/outside/', file, win));
  const s3 = { provider: 's3', endpoint: 'https://s3.test', bucket: 'images', prefix: '素材/', pathStyle: true, accessKey: 'TEST', secretKey: 'testsecret', sessionToken: 'session', region: 'us-east-1' };
  await upload(s3, '素材/子目录/', file, win);
  const s = calls.at(-1), url = new URL(s.url); assert.equal(s.method, 'PUT'); assert.equal(s.body, bytes); assert.equal(url.searchParams.get('X-Amz-Security-Token'), 'session');
  const signature = url.searchParams.get('X-Amz-Signature'); url.searchParams.delete('X-Amz-Signature');
  const query = url.search.slice(1); // Keep original RFC3986 encoding (URLSearchParams would re-encode spaces).
  const time = url.searchParams.get('X-Amz-Date'), day = time.slice(0, 8), scope = day + '/us-east-1/s3/aws4_request';
  let key = Buffer.from('AWS4testsecret'); for (const part of [day, 'us-east-1', 's3', 'aws4_request']) key = crypto.createHmac('sha256', key).update(part).digest();
  // Reconstruct canonical query directly from original URL so percent escapes remain unchanged.
  const originalQuery = new URL(s.url).search.slice(1).split('&').filter(p => !p.startsWith('X-Amz-Signature=')).join('&');
  const canonical = 'PUT\n' + url.pathname + '\n' + originalQuery + '\nhost:' + url.host + '\n\nhost\nUNSIGNED-PAYLOAD';
  const expected = crypto.createHmac('sha256', key).update('AWS4-HMAC-SHA256\n' + time + '\n' + scope + '\n' + crypto.createHash('sha256').update(canonical).digest('hex')).digest('hex');
  assert.equal(signature, expected);
  await assert.rejects(upload(s3, 'elsewhere/', file, win));
  await assert.rejects(upload(s3, '素材/../outside/', file, win));
  await upload(s3, '素材/', { ...file, size: 101 * 1024 * 1024 }, win); // Synthetic metadata; no allocation of a large test buffer.
  const { cloudCreateFolder, cloudMove, cloudDelete, cloudChild } = ctx.module.exports;
  await cloudCreateFolder(dav, dav.endpoint, '新文件夹', win); assert.equal(calls.at(-1).method, 'MKCOL');
  await cloudCreateFolder(s3, '素材/', '新文件夹', win); assert.equal(calls.at(-1).body.byteLength, 0);
  await cloudMove(dav, { id: dav.endpoint + 'old.png' }, dav.endpoint + 'new.png', win);
  assert.equal(calls.at(-1).method, 'MOVE'); assert.equal(calls.at(-1).headers.Overwrite, 'F');
  await cloudMove(dav, { id: dav.endpoint + 'old.png' }, dav.endpoint + 'copy.png', win, true); assert.equal(calls.at(-1).method, 'COPY');
  const source = { id: '素材/old.png', version: '"etag"' };
  const beforeMove = calls.length;
  await cloudMove(s3, source, '素材/new.png', win);
  const copied = calls[beforeMove]; assert.equal(copied.method, 'PUT'); assert.equal(copied.headers['x-amz-copy-source'], '/images/%E7%B4%A0%E6%9D%90/old.png');
  assert(new URL(copied.url).searchParams.get('X-Amz-SignedHeaders').includes('x-amz-copy-source'));
  assert.equal(calls.at(-1).method, 'DELETE'); assert.equal(calls.at(-1).headers['If-Match'], '"etag"');
  await cloudDelete(dav, { id: dav.endpoint + 'old.png' }, win); assert.equal(calls.at(-1).method, 'DELETE');
  await assert.rejects(cloudDelete(dav, { id: dav.endpoint }, win));
  await assert.rejects(cloudDelete(s3, { id: '素材/' }, win));
  assert.throws(() => cloudChild(s3, '素材/', '../escape'));
  status = 412; const beforeFailure = calls.length; await assert.rejects(cloudMove(s3, source, '素材/collision.png', win)); assert.equal(calls.length, beforeFailure + 1, 'Failed copy must never delete source');
  status = 403; await assert.rejects(upload(s3, '素材/', file, win), /403/);
  status = 412; await assert.rejects(upload(dav, dav.endpoint, file, win), /412/);
  console.log('PASS cloud management: uploads above old limit, WebDAV MKCOL/MOVE/COPY/DELETE, S3 copy-before-delete and signed source headers, conflicts preserve source, root protection; upload signature and byte preservation');
}
run().catch(e => { console.error(e); process.exitCode = 1; });
