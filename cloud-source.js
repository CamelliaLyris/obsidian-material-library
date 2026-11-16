// Build source: bundled into main.js; never required by Obsidian at runtime.
const CLOUD_PROVIDERS = { webdav: 'WebDAV', s3: 'S3 / S3 兼容' };
const DAV_PROVIDERS = ['webdav'];
const cloudImage = name => /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(name);
const secretKeys = ['password', 'token', 'directoryPassword', 'secretKey', 'sessionToken'];
function migrateCloudConnection(original) {
  const c = { ...original };
  if (['baidu', 'quark', 'pan115', 'guangya'].includes(c.provider)) c.provider = 'webdav';
  return c;
}
const encodeRFC = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function httpURL(value) {
  let url; try { url = new URL(value); } catch (_) { throw new Error('请填写完整的 http(s) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('地址需为 http(s)，不要在地址中包含用户名、密码、查询参数或片段');
  return url;
}
function cloudXML(text, win) {
  const xml = new win.DOMParser().parseFromString(text, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) throw new Error('服务返回的不是有效 XML');
  return xml;
}
const xmlNodes = (node, name) => [...node.getElementsByTagNameNS('*', name)];
const xmlText = (node, name) => xmlNodes(node, name)[0]?.textContent || '';
async function cloudRequest(url, options = {}) {
  let response, timer;
  try {
    response = await Promise.race([
      requestUrl({ url, method: 'GET', throw: false, ...options }).catch(() => { throw new Error('网络请求失败，请检查地址、证书与网络连接'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('请求超过 30 秒，请检查网络或稍后重试')), 30000); })
    ]);
  } finally { clearTimeout(timer); }
  if (response.status < 200 || response.status >= 300) {
    const message = response.status === 401 ? '授权失效，请更新令牌或密码' : response.status === 403 ? '没有读取权限，请检查授权范围或 S3 策略' : response.status === 429 ? '请求过于频繁，请稍后重试' : '请检查服务地址、网络和权限';
    throw new Error(`HTTP ${response.status}：${message}`);
  }
  return response;
}
function davAuth(c, win) {
  if (!c.username && !c.password) return {};
  const bytes = new win.TextEncoder().encode((c.username || '') + ':' + (c.password || ''));
  return { Authorization: 'Basic ' + win.btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')) };
}
function safeDavURL(value, c) {
  const root = httpURL(c.endpoint); if (!root.pathname.endsWith('/')) root.pathname += '/';
  const url = new URL(value, root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.username || url.password) throw new Error('服务返回了素材目录之外的地址');
  return url.href;
}
async function s3SignedURL(c, key = '', params = {}, date = new Date(), cryptoAPI = globalThis.crypto) {
  if (!cryptoAPI?.subtle) throw new Error('当前环境不支持 S3 签名所需的 Web Crypto');
  const endpoint = httpURL(c.endpoint), url = new URL(endpoint.href);
  if (!c.bucket || !c.accessKey || !c.secretKey) throw new Error('请填写 Bucket、Access Key 和 Secret Key');
  if (key.split('/').some(p => p === '.' || p === '..')) throw new Error('暂不支持含点路径段的 S3 对象名');
  if (!c.pathStyle) url.hostname = c.bucket + '.' + url.hostname;
  const base = endpoint.pathname.replace(/\/$/, '');
  url.pathname = base + (c.pathStyle ? '/' + encodeRFC(c.bucket) : '') + '/' + key.split('/').map(encodeRFC).join('/');
  const time = date.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = time.slice(0, 8);
  const scope = `${day}/${c.region || 'us-east-1'}/s3/aws4_request`;
  const query = { ...params, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${c.accessKey}/${scope}`, 'X-Amz-Date': time, 'X-Amz-Expires': '300', 'X-Amz-SignedHeaders': 'host' };
  if (c.sessionToken) query['X-Amz-Security-Token'] = c.sessionToken;
  const canonicalQuery = Object.entries(query).map(([k,v]) => [encodeRFC(k), encodeRFC(String(v))]).sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1).map(pair => pair.join('=')).join('&');
  const encoder = new TextEncoder();
  const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  const hash = async value => hex(await cryptoAPI.subtle.digest('SHA-256', encoder.encode(value)));
  const hmac = async (keyBytes, value) => cryptoAPI.subtle.sign('HMAC', await cryptoAPI.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), encoder.encode(value));
  const canonical = `GET\n${url.pathname}\n${canonicalQuery}\nhost:${url.host}\n\nhost\nUNSIGNED-PAYLOAD`;
  let signingKey = encoder.encode('AWS4' + c.secretKey);
  for (const part of [day, c.region || 'us-east-1', 's3', 'aws4_request']) signingKey = await hmac(signingKey, part);
  const signature = hex(await hmac(signingKey, `AWS4-HMAC-SHA256\n${time}\n${scope}\n${await hash(canonical)}`));
  url.search = canonicalQuery + '&X-Amz-Signature=' + signature; return url.href;
}
function cloudRoot(c) {
  if (DAV_PROVIDERS.includes(c.provider)) { const u = httpURL(c.endpoint); if (!u.pathname.endsWith('/')) u.pathname += '/'; return u.href; }
  if (c.provider === 's3') return c.prefix || '';
  throw new Error('不支持的连接类型，请使用 WebDAV 或 S3');
}
async function listCloud(c, folder, page, win) {
  if (DAV_PROVIDERS.includes(c.provider)) {
    const url = safeDavURL(folder, c);
    const response = await cloudRequest(url, { method: 'PROPFIND', headers: { ...davAuth(c, win), Depth: '1', 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontenttype/><d:getcontentlength/><d:getetag/><d:getlastmodified/></d:prop></d:propfind>' });
    const xml = cloudXML(response.text, win), items = [];
    for (const node of xmlNodes(xml, 'response')) {
      const href = xmlText(node, 'href'); if (!href) continue;
      let id; try { id = safeDavURL(new URL(href, url).href, c); } catch (_) { continue; }
      if (new URL(id).pathname.replace(/\/$/, '') === new URL(url).pathname.replace(/\/$/, '')) continue;
      const props = xmlNodes(node, 'propstat').find(p => /\s200\s/.test(xmlText(p, 'status'))); if (!props) continue;
      const isFolder = xmlNodes(props, 'collection').length > 0;
      let name = xmlText(props, 'displayname'); if (!name) { try { name = decodeURIComponent(new URL(id).pathname.replace(/\/$/, '').split('/').pop()); } catch (_) { name = id; } }
      if (isFolder || cloudImage(name)) items.push({ id, name, folder: isFolder, size: Number(xmlText(props, 'getcontentlength')) || 0, version: xmlText(props, 'getetag') || xmlText(props, 'getlastmodified') });
    }
    return { items, next: null };
  }
  if (c.provider === 's3') {
    const params = { 'list-type': '2', delimiter: '/', prefix: folder, 'max-keys': '100' }; if (page) params['continuation-token'] = page;
    const response = await cloudRequest(await s3SignedURL(c, '', params));
    const xml = cloudXML(response.text, win), items = [];
    for (const node of xmlNodes(xml, 'CommonPrefixes')) { const id = xmlText(node, 'Prefix'); items.push({ id, name: id.replace(/\/$/, '').split('/').pop(), folder: true }); }
    for (const node of xmlNodes(xml, 'Contents')) { const id = xmlText(node, 'Key'); if (cloudImage(id)) items.push({ id, name: id.split('/').pop(), folder: false, size: Number(xmlText(node, 'Size')) || 0, version: xmlText(node, 'ETag') || xmlText(node, 'LastModified') }); }
    return { items, next: xmlText(xml, 'NextContinuationToken') || null };
  }
  throw new Error('不支持的连接类型，请使用 WebDAV 或 S3');
}
async function cloudImageRequest(c, item, win, thumbnail) {
  let url, headers = {};
  if (item.size > 30 * 1024 * 1024 && !thumbnail) throw new Error('原图超过 30 MB，请在网盘客户端查看');
  if (thumbnail && c.thumbnailTemplate) {
    const location = serverThumbnailLocation(c, item);
    url = location.key != null ? await s3SignedURL(c, location.key) : location.url;
    if (c.provider === 'webdav' && new URL(url).origin === httpURL(c.endpoint).origin) headers = davAuth(c, win);
  } else if (DAV_PROVIDERS.includes(c.provider)) { url = safeDavURL(item.id, c); headers = davAuth(c, win); }
  else if (c.provider === 's3') {
    if (c.prefix && !item.id.startsWith(c.prefix)) throw new Error('图片超出了配置的 S3 目录');
    url = await s3SignedURL(c, item.id);
  }
  else throw new Error('不支持的连接类型，请使用 WebDAV 或 S3');
  const response = await cloudRequest(url, { headers });
  if (response.arrayBuffer.byteLength > 30 * 1024 * 1024) throw new Error('图片超过 30 MB，已停止显示');
  const type = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1]?.split(';')[0];
  if (type && !type.startsWith('image/') && type !== 'application/octet-stream') throw new Error('返回内容不是图片');
  const ext = item.name.split('.').pop().toLowerCase();
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' }[ext] || 'image/' + ext;
  return new win.Blob([response.arrayBuffer], { type: type?.startsWith('image/') ? type : mime });
}
function serverThumbnailLocation(c, item) {
  let path = item.id;
  if (c.provider === 'webdav') {
    const root = cloudRoot(c); const url = safeDavURL(item.id, c);
    path = decodeURIComponent(new URL(url).pathname.slice(new URL(root).pathname.length));
  } else if (c.provider === 's3') {
    if (c.prefix && !item.id.startsWith(c.prefix)) throw new Error('图片超出了配置的 S3 目录');
  } else throw new Error('不支持的缩略图连接类型');
  const template = c.thumbnailTemplate.trim(), sameBucket = template.startsWith('s3://');
  if (sameBucket && c.provider !== 's3') throw new Error('s3:// 缩略图规则仅用于 S3');
  const values = { path, name: item.name, bucket: c.bucket || '', width: String(c.thumbnailSize || 480), height: String(c.thumbnailSize || 480) };
  const location = template.replace(/\{(path|pathSegments|name|bucket|width|height)\}/g, (_, key) => key === 'pathSegments' ? (sameBucket ? path : path.split('/').map(encodeRFC).join('/')) : (sameBucket ? values[key] : encodeRFC(values[key])));
  if (/[{}]/.test(location)) throw new Error('缩略图规则包含未知占位符');
  if (sameBucket) {
    const key = location.slice(5);
    if (!key || key.startsWith('/') || key.split('/').some(p => p === '.' || p === '..')) throw new Error('S3 缩略图对象路径不正确');
    return { key };
  }
  const url = new URL(location, httpURL(c.endpoint).href.replace(/\/$/, '') + '/');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('缩略图规则必须是 http(s) 地址或 S3 同桶对象规则');
  return { url: url.href };
}
async function withOriginalPriority(plugin, load) {
  plugin.originalRequests = (plugin.originalRequests || 0) + 1;
  try { return await load(); }
  finally { plugin.originalRequests--; for (const view of plugin.cloudViews || []) view.pump(); }
}

class CloudPreviewCache {
  constructor(maxBytes = 64 * 1024 * 1024, ttl = 5 * 60 * 1000) { this.maxBytes = maxBytes; this.ttl = ttl; this.entries = new Map(); this.pending = new Map(); this.bytes = 0; this.generation = 0; }
  peek(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time >= this.ttl) { this.remove(key); return null; }
    this.entries.delete(key); this.entries.set(key, entry); return entry.blob;
  }
  remove(key) { const entry = this.entries.get(key); if (entry) { this.bytes -= entry.blob.size; this.entries.delete(key); } }
  async get(key, load) {
    const cached = this.peek(key); if (cached) return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    const generation = this.generation;
    const promise = Promise.resolve().then(load).then(blob => {
      if (generation === this.generation && blob.size <= this.maxBytes) {
        this.remove(key);
        while (this.bytes + blob.size > this.maxBytes && this.entries.size) this.remove(this.entries.keys().next().value);
        this.entries.set(key, { blob, time: Date.now() }); this.bytes += blob.size;
      }
      return blob;
    }).finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
    this.pending.set(key, promise); return promise;
  }
  clear() { this.generation++; this.entries.clear(); this.pending.clear(); this.bytes = 0; }
}
function previewKey(c, item) {
  // In-memory only; include account, credentials and file revision to prevent cross-account reuse.
  return JSON.stringify([c.id, c.provider, c.endpoint, c.username, c.password, c.bucket, c.region, c.pathStyle, c.accessKey, c.secretKey, c.sessionToken, item.id, item.size, item.version]);
}
async function preserveCloudFormat(blob) {
  // Do not flatten animations or rasterize vector images for a thumbnail.
  if (/image\/(gif|svg\+xml|apng|avif)/.test(blob.type)) return true;
  if (blob.type === 'image/webp') {
    const header = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
    const chunk = String.fromCharCode(...header.slice(12, 16));
    return chunk === 'VP8X' ? !!(header[20] & 2) : !['VP8 ', 'VP8L'].includes(chunk);
  }
  if (blob.type === 'image/png') {
    const header = await blob.slice(0, 65536).arrayBuffer(), bytes = new Uint8Array(header), view = new DataView(header);
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (type === 'acTL') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      offset += 12 + view.getUint32(offset);
    }
    return true; // Uncertain PNG metadata: retain the original rather than lose animation.
  }
  return false;
}
async function smallCloudPreview(blob, win, options = {}) {
  if (options.convertPreviews === false || !win.createImageBitmap) return blob;
  let bitmap;
  try {
    if (await preserveCloudFormat(blob)) return blob;
    bitmap = await win.createImageBitmap(blob);
    const ratio = Math.min(1, (options.previewEdge || 480) / Math.max(bitmap.width, bitmap.height));
    if (ratio === 1 && blob.size < 32768) return blob;
    const canvas = win.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d'); if (!context) return blob;
    context.imageSmoothingQuality = 'high'; context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const thumbnail = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', (options.previewQuality || 78) / 100));
    return thumbnail?.type === 'image/webp' && thumbnail.size < blob.size ? thumbnail : blob;
  } catch (_) { return blob; } finally { bitmap?.close(); }
}
function cloudCache(plugin) { return plugin.cloudPreviewCache ||= new CloudPreviewCache(); }
function thumbnailKey(plugin, c, item) {
  const { convertPreviews = true, previewEdge = 480, previewQuality = 78 } = plugin.options;
  return previewKey(c, item) + ':thumbnail:' + JSON.stringify([convertPreviews, previewEdge, previewQuality, c.thumbnailTemplate || '']);
}
function cachedCloudImage(plugin, c, item, win, thumbnail) {
  const cache = cloudCache(plugin), key = previewKey(c, item);
  const original = () => cache.get(key + ':original', async () => (await plugin.readLocalCloudImage?.(c, item, win)) || cloudImageRequest(c, item, win, false));
  const options = { ...plugin.options };
  return thumbnail ? cache.get(thumbnailKey(plugin, c, item), async () => {
    let source;
    if (c.thumbnailTemplate) {
      source = await plugin.readLocalCloudImage?.(c, item, win);
      try { if (!source) source = await cloudImageRequest({ ...c, thumbnailSize: options.previewEdge }, item, win, true); }
      catch (_) { /* Unavailable server thumbnail: fall back to the original. */ }
    }
    return smallCloudPreview(source || await original(), win, options);
  }) : original();
}

function thisCloudSettings(plugin) {
  const modal = new Modal(plugin.app); plugin.modals.add(modal);
  const draw = () => {
    modal.contentEl.empty(); modal.contentEl.createEl('h2', { text: '云端连接管理' });
    modal.contentEl.createEl('p', { text: '每种类型都可以添加多个连接，地址、账号、Bucket 和目录独立保存。请分别命名，例如「家里 NAS」「工作 NAS」「游戏素材」。' });
    for (const [provider, label] of Object.entries(CLOUD_PROVIDERS)) {
      const connections = plugin.options.connections.filter(c => c.provider === provider);
      modal.contentEl.createEl('h3', { text: `${label} · ${connections.length} 个连接` });
      for (const c of connections) new Setting(modal.contentEl).setName(c.name).setDesc([c.endpoint, c.provider === 's3' ? c.bucket + '/' + (c.prefix || '') : ''].filter(Boolean).join(' · '))
        .addButton(b => b.setButtonText('编辑').onClick(() => editCloudConnection(plugin, c, draw)))
        .addButton(b => b.setButtonText('复制为新连接').onClick(() => editCloudConnection(plugin, null, draw, provider, c)))
        .addButton(b => b.setButtonText('移除').onClick(async () => { const next = { ...plugin.options, connections: plugin.options.connections.filter(x => x.id !== c.id) }; try { await plugin.saveData(next); plugin.options = next; plugin.cloudSecrets.delete(c.id); notifyCloudConnections(plugin); draw(); } catch (_) { new Notice('移除失败，请重试'); } }));
      new Setting(modal.contentEl).addButton(b => b.setButtonText('＋ 添加 ' + label).setCta().onClick(() => editCloudConnection(plugin, null, draw, provider)));
    }
    modal.contentEl.createEl('p', { text: '默认只在本次运行中保留凭据。复制连接后需点击保存，原连接不会被修改。', cls: 'ml-status' });
  };
  modal.onOpen = draw; modal.onClose = () => plugin.modals.delete(modal); modal.open();
}
function notifyCloudConnections(plugin) { for (const view of plugin.cloudViews || []) view.refreshConnections(); }
function editCloudConnection(plugin, original, changed, provider = 'webdav', template = null) {
  const modal = new Modal(plugin.app); plugin.modals.add(modal);
  const base = original || template;
  const draft = { provider, name: '', endpoint: '', region: 'us-east-1', bucket: '', prefix: '', pathStyle: true, path: '/', username: '', remember: false, ...base, ...plugin.cloudSecrets.get(base?.id), id: original?.id || stamp() };
  if (template) { draft.name = (template.name || CLOUD_PROVIDERS[provider]) + ' 副本'; draft.remember = false; }
  const draw = () => {
    const el = modal.contentEl; el.empty(); el.createEl('h2', { text: original ? '编辑网盘连接' : '添加网盘连接' });
    new Setting(el).setName('服务').addDropdown(c => { for (const [value, name] of Object.entries(CLOUD_PROVIDERS)) c.addOption(value, name); c.setValue(draft.provider).onChange(v => { draft.provider = v; draw(); }); });
    const field = (key, label, password = false, desc = '') => new Setting(el).setName(label).setDesc(desc).addText(c => { c.setValue(draft[key] || '').onChange(v => draft[key] = v); if (password) c.inputEl.type = 'password'; });
    field('name', '连接名称', false, '为每个账号或目录分别命名；同名会自动加序号，不会覆盖原连接');
    if (DAV_PROVIDERS.includes(draft.provider)) {
      field('endpoint', 'WebDAV 素材目录地址', false, '例如 https://你的网关/dav/网盘/图片/'); field('username', 'WebDAV 用户名'); field('password', 'WebDAV 密码', true);
    } else if (draft.provider === 's3') {
      field('endpoint', 'S3 Endpoint', false, '例如 https://s3.us-east-1.amazonaws.com（不包含 Bucket）');
      field('bucket', 'Bucket'); field('region', 'Region'); field('prefix', '起始目录 Prefix', false, '可留空；文件夹请以 / 结尾');
      field('accessKey', 'Access Key ID'); field('secretKey', 'Secret Access Key', true); field('sessionToken', 'Session Token（可选）', true);
      new Setting(el).setName('Path-style 地址').setDesc('S3 兼容服务常用；AWS 可关闭以使用 Bucket 子域名。').addToggle(c => c.setValue(draft.pathStyle).onChange(v => draft.pathStyle = v));
    }
    field('thumbnailTemplate', '服务端缩略图规则（可选）', false, '服务需支持。占位符：{path}、{pathSegments}、{name}、{width}、{height}、{bucket}。URL 规则如 /thumb?path={path}&width={width}；S3 同桶规则如 s3://thumbs/{path}.webp。留空沿用原图。');
    new Setting(el).setName('重启后保留凭据').setDesc('开启后凭据会明文写入插件 data.json，可能随笔记库同步。关闭时凭据仅留在本次运行内存中。').addToggle(c => c.setValue(draft.remember).onChange(v => draft.remember = v));
    new Setting(el).addButton(b => b.setButtonText('测试连接').onClick(async () => { b.setDisabled(true); try { validateCloudConnection(draft); await listCloud(draft, cloudRoot(draft), null, el.ownerDocument.defaultView); new Notice('连接成功，可以读取文件列表'); } catch (err) { new Notice('连接失败：' + err.message); } finally { b.setDisabled(false); } }))
      .addButton(b => b.setButtonText('保存连接').setCta().onClick(async () => { b.setDisabled(true); try {
        validateCloudConnection(draft);
        const baseName = draft.name.trim() || CLOUD_PROVIDERS[draft.provider];
        const usedNames = new Set(plugin.options.connections.filter(c => c.id !== draft.id).map(c => c.name));
        let name = baseName, n = 2; while (usedNames.has(name)) name = `${baseName} ${n++}`;
        const saved = { ...draft, name };
        if (!saved.remember) for (const key of secretKeys) delete saved[key];
        const next = { ...plugin.options, connections: [...plugin.options.connections.filter(c => c.id !== draft.id), saved] };
        await plugin.saveData(next); plugin.options = next;
        plugin.cloudSecrets.set(draft.id, Object.fromEntries(secretKeys.map(key => [key, draft[key] || ''])));
        notifyCloudConnections(plugin);
        changed(); modal.close(); new Notice('连接已保存');
      } catch (err) { new Notice(err.message); } finally { b.setDisabled(false); } }));
  };
  modal.onOpen = draw; modal.onClose = () => plugin.modals.delete(modal); modal.open();
}
function validateCloudConnection(c) {
  if (!CLOUD_PROVIDERS[c.provider]) throw new Error('不支持的连接类型');
  httpURL(c.endpoint);
  if (c.provider === 's3' && (!/^[a-zA-Z0-9._-]+$/.test(c.bucket || '') || !c.accessKey || !c.secretKey)) throw new Error('请填写合法 Bucket、Access Key 和 Secret Key');
  if (c.provider === 's3' && c.prefix && !c.prefix.endsWith('/')) throw new Error('起始目录 Prefix 请以 / 结尾');
  if (c.thumbnailTemplate) serverThumbnailLocation(c, { id: c.provider === 's3' ? (c.prefix || '') + 'example.png' : new URL('example.png', cloudRoot(c)).href, name: 'example.png' });
}

class CloudBrowser extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.items = []; this.stack = []; this.urls = new Set(); this.previewBytes = 0; this.generation = 0; this.requestSerial = 0; this.busy = false; this.closed = false; this.page = null; this.auto = true; this.query = ''; this.active = 0; this.queue = []; }
  getViewType() { return CLOUD_VIEW; }
  getDisplayText() { return '云端素材'; }
  getIcon() { return 'cloud'; }
  onOpen() {
    this.closed = false; this.contentEl.empty(); this.contentEl.addClass('ml-view'); this.contentEl.addClass('ml-cloud-view');
    this.plugin.cloudViews ||= new Set(); this.plugin.cloudViews.add(this);
    const heading = this.contentEl.createDiv({ cls: 'ml-heading' });
    heading.createEl('h2', { text: '云端素材' });
    const local = heading.createEl('button', { text: '本地素材' }); local.onclick = () => this.plugin.openLibrary();
    const tools = this.contentEl.createDiv({ cls: 'ml-tools' });
    this.select = tools.createEl('select', { attr: { 'aria-label': '网盘连接' } });
    const add = tools.createEl('button', { text: '管理连接' }); add.onclick = () => thisCloudSettings(this.plugin);
    const refresh = tools.createEl('button', { text: '刷新连接列表' }); refresh.onclick = () => this.refreshConnections();
    const clearCache = tools.createEl('button', { text: '清除预览缓存' }); clearCache.onclick = () => { cloudCache(this.plugin).clear(); this.draw(); new Notice('预览缓存已清除'); };
    const up = tools.createEl('button', { text: '返回上层' }); up.onclick = () => { if (this.busy || this.stack.length <= 1) return; this.stack.pop(); this.load(false); };
    this.search = tools.createEl('input', { type: 'search', attr: { placeholder: '搜索已加载的当前目录', 'aria-label': '搜索云端图片' } }); this.search.oninput = () => { this.query = this.search.value; clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => { if (!this.closed) this.draw(); }, 150); };
    const label = this.contentEl.createEl('label', { cls: 'ml-cloud-auto' });
    const checkbox = label.createEl('input', { type: 'checkbox' }); label.createSpan({ text: '自动预览可见图片（WebDAV / S3 可能读取原图，消耗网络流量）' });
    checkbox.checked = this.auto;
    checkbox.onchange = () => { this.auto = checkbox.checked; this.draw(); };
    this.status = this.contentEl.createDiv({ cls: 'ml-status' });
    this.grid = this.contentEl.createDiv({ cls: 'ml-grid' });
    this.more = this.contentEl.createEl('button', { text: '加载下一页' }); this.more.onclick = () => this.load(true); this.more.style.display = 'none';
    this.select.onchange = () => { this.reset(); const stored = this.plugin.options.connections.find(c => c.id === this.select.value); if (!stored || !CLOUD_PROVIDERS[stored.provider]) return; this.connection = { ...stored, ...this.plugin.cloudSecrets.get(stored.id) }; try { validateCloudConnection(this.connection); this.stack = [{ id: cloudRoot(this.connection), name: this.connection.name }]; this.load(false); } catch (err) { this.status.setText(err.message + '，请编辑连接补充授权'); } };
    this.status.setText('选择连接后自动预览可见图片，不会写入笔记库。');
    this.refreshConnections();
  }
  refreshConnections() {
    if (this.closed || !this.select) return;
    const selected = this.select.value;
    this.select.empty(); this.select.createEl('option', { text: '选择一个连接（可添加多个同类型连接）', value: '' });
    for (const [provider, label] of Object.entries(CLOUD_PROVIDERS)) {
      const connections = this.plugin.options.connections.filter(c => c.provider === provider);
      if (!connections.length) continue;
      const group = this.select.createEl('optgroup', { attr: { label: `${label}（${connections.length}）` } });
      for (const c of connections) group.createEl('option', { text: c.name, value: c.id });
    }
    const stored = this.plugin.options.connections.find(c => c.id === selected);
    if (stored && CLOUD_PROVIDERS[stored.provider]) {
      this.select.value = selected;
      const current = { ...stored, ...this.plugin.cloudSecrets.get(stored.id) };
      if (JSON.stringify(current) !== JSON.stringify(this.connection)) this.select.onchange();
    } else if (this.connection) { this.reset(); this.status.setText('当前连接已移除，请选择其他连接'); }
  }
  clearURLs() { this.observer?.disconnect(); this.queue = []; for (const url of this.urls) this.contentEl.ownerDocument.defaultView.URL.revokeObjectURL(url); this.urls.clear(); this.previewBytes = 0; }
  reset() { this.requestSerial++; this.generation++; this.busy = false; this.clearURLs(); this.items = []; this.stack = []; this.page = null; this.connection = null; this.grid.empty(); this.more.style.display = 'none'; }
  async load(append) {
    if (this.busy || !this.connection || !this.stack.length) return;
    const requestId = ++this.requestSerial; this.generation++; this.busy = true; this.more.disabled = true;
    this.clearURLs(); this.status.setText('正在读取云端文件列表…');
    try {
      const result = await listCloud(this.connection, this.stack.at(-1).id, append ? this.page : null, this.contentEl.ownerDocument.defaultView);
      if (this.closed || requestId !== this.requestSerial) return;
      this.items = append ? [...new Map([...this.items, ...result.items].map(item => [item.id, item])).values()] : result.items;
      this.page = result.next; this.draw();
    } catch (err) { if (!this.closed && requestId === this.requestSerial) { this.grid.empty(); this.status.setText('读取失败：' + err.message); } }
    finally { if (requestId === this.requestSerial) { this.busy = false; this.more.disabled = false; } }
  }
  draw() {
    this.clearURLs(); const generation = ++this.generation; const win = this.contentEl.ownerDocument.defaultView;
    const connection = { ...this.connection };
    this.grid.empty(); this.grid.style.setProperty('--ml-size', this.plugin.options.size + 'px');
    const items = this.items.filter(i => i.name.toLowerCase().includes(this.query.toLowerCase()));
    this.status.setText(`${this.stack.map(s => s.name).join(' / ')} · 已加载 ${this.items.length} 项 · 图片仅临时预览，不落盘`);
    this.more.style.display = this.page ? '' : 'none'; this.more.disabled = false;
    if (!items.length) this.grid.createEl('p', { text: '当前目录没有匹配的图片或文件夹；可以尝试下一页。' });
    const paint = (item, holder) => {
      if (holder.dataset.loading || generation !== this.generation) return;
      holder.dataset.loading = 'true'; holder.setText('读取中…');
      this.queue.push(async () => {
        try {
          const blob = await cachedCloudImage(this.plugin, connection, item, win, true);
          if (this.closed || generation !== this.generation) return;
          if (this.previewBytes + blob.size > 64 * 1024 * 1024) throw new Error('当前目录预览已达 64 MB，请搜索缩小范围，或单独查看大图');
          this.previewBytes += blob.size;
          const url = win.URL.createObjectURL(blob); this.urls.add(url); holder.empty(); holder.createEl('img', { attr: { src: url, alt: item.name, decoding: 'async' } });
        } catch (err) { if (!this.closed && generation === this.generation) { holder.setText('点击重试'); holder.dataset.loading = ''; holder.title = err.message; } }
      }); this.pump();
    };
    if (win.IntersectionObserver) this.observer = new win.IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) { const load = e.target._cloudLoad; this.observer.unobserve(e.target); load?.(); } }, { root: null });
    // Limit each rendered page to 100 tiles to bound preview memory; all listed items remain searchable.
    for (const item of items.slice(0, 100)) {
      const tile = this.grid.createEl('div', { cls: 'ml-cloud-tile' });
      const thumb = tile.createEl('button', { cls: 'ml-cloud-thumb', attr: { 'aria-label': item.name } });
      if (item.folder) { setIcon(thumb, 'folder'); thumb.onclick = () => { if (!this.busy) { this.stack.push({ id: item.id, name: item.name }); this.load(false); } }; }
      else {
        thumb.setText(this.auto ? '等待加载…' : '点击预览'); thumb.onclick = () => paint(item, thumb);
        const full = tile.createEl('button', { text: '查看大图', cls: 'ml-cloud-full' }); full.onclick = () => this.fullPreview(item);
        const insert = tile.createEl('button', { text: '下载到本地并插入', cls: 'ml-cloud-full' }); insert.onclick = async () => { if (insert.disabled) return; insert.disabled = true; try { await this.plugin.insertCloud(connection, item); } finally { insert.disabled = false; } };
        if (cloudCache(this.plugin).peek(thumbnailKey(this.plugin, connection, item))) paint(item, thumb);
        else if (this.auto) { thumb._cloudLoad = () => paint(item, thumb); if (this.observer) this.observer.observe(thumb); else paint(item, thumb); }
      }
      tile.createDiv({ cls: 'ml-name', text: item.name });
    }
    if (items.length > 100) this.grid.createEl('p', { text: '为控制预览内存，仅展示前 100 项；请搜索名称缩小范围。' });
  }
  pump() { if (this.closed || this.plugin.originalRequests > 0) return; while (this.active < (this.plugin.options.previewConcurrency || 4) && this.queue.length) { const task = this.queue.shift(); this.active++; task().finally(() => { this.active--; this.pump(); }); } }
  async fullPreview(item) {
    const modal = new Modal(this.app), c = { ...this.connection }, win = this.contentEl.ownerDocument.defaultView; let closed = false; const urls = new Set();
    this.plugin.modals.add(modal);
    modal.onOpen = async () => { modal.modalEl.addClass('ml-preview'); modal.contentEl.createEl('h3', { text: item.name }); const status = modal.contentEl.createEl('p', { text: '正在读取原图…' });
      const image = modal.contentEl.createEl('img', { attr: { alt: item.name } });
      const small = cloudCache(this.plugin).peek(thumbnailKey(this.plugin, c, item));
      if (small) { const url = win.URL.createObjectURL(small); urls.add(url); image.src = url; image.dataset.stage = 'thumbnail'; status.setText('先显示缩略图，正在优先加载原图…'); }
      const insert = modal.contentEl.createEl('button', { text: '下载到本地并插入', cls: 'mod-cta' }); insert.onclick = async () => { if (insert.disabled) return; insert.disabled = true; try { await this.plugin.insertCloud(c, item); } finally { insert.disabled = false; } };
      try {
        const blob = await withOriginalPriority(this.plugin, () => cachedCloudImage(this.plugin, c, item, win, false));
        if (closed) return;
        const url = win.URL.createObjectURL(blob); urls.add(url);
        const decoded = new win.Image(); decoded.src = url;
        if (decoded.decode) await decoded.decode();
        if (closed) return;
        image.src = url; image.dataset.stage = 'original'; status.setText('原图已加载');
        for (const old of urls) if (old !== url) { win.URL.revokeObjectURL(old); urls.delete(old); }
      }
      catch (err) { if (!closed) status.setText('无法预览：' + err.message); }
    };
    modal.onClose = () => { closed = true; for (const url of urls) win.URL.revokeObjectURL(url); urls.clear(); this.plugin.modals.delete(modal); }; modal.open();
  }
  onClose() { this.closed = true; clearTimeout(this.searchTimer); this.requestSerial++; this.generation++; this.clearURLs(); this.plugin.cloudViews?.delete(this); }
}
