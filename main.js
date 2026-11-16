const { Plugin, ItemView, MarkdownView, MarkdownRenderChild, PluginSettingTab, Setting, Modal, Menu, Notice, normalizePath, setIcon, requestUrl } = require('obsidian');
const VIEW = 'personal-material-library';
const CLOUD_VIEW = 'personal-material-library-cloud';
const TYPES = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'],
  video: ['mp4', 'webm', 'mov', 'mkv'], audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac'], document: ['pdf']
};
const DEFAULTS = { root: '素材库', sources: ['从夯到拉/素材库'], size: 160, sort: 'newest', showNames: true, previewConcurrency: 4, convertPreviews: true, previewEdge: 480, previewQuality: 78, connections: [] };
const kind = file => Object.keys(TYPES).find(k => TYPES[k].includes(file.extension?.toLowerCase()));
const within = (p, folder) => p === folder || p.startsWith(folder + '/');
function folderPath(value) {
  const result = String(value || '').trim().replace(/\\/g, '/');
  if (!result || result.split('/').some(p => !p || p.startsWith('.') || /[:*?"<>|\x00-\x1f]/.test(p) || /[. ]$/.test(p))) throw new Error('请填写库内相对路径，例如「素材库/封面」，不要包含隐藏目录或特殊字符');
  return normalizePath(result);
}
const stamp = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);

class NameModal extends Modal {
  constructor(app, title, submit) { super(app); this.heading = title; this.submit = submit; }
  onOpen() {
    this.contentEl.createEl('h2', { text: this.heading });
    const form = this.contentEl.createEl('form');
    const input = form.createEl('input', { type: 'text', attr: { placeholder: '例如：游戏封面 / 角色 / 表情包', 'aria-label': '分类名称' } });
    input.required = true; input.style.width = '100%';
    const button = form.createEl('button', { type: 'submit', text: '创建', cls: 'mod-cta' });
    form.addEventListener('submit', async e => { e.preventDefault(); button.disabled = true;
      try { await this.submit(input.value); this.close(); } catch (err) { new Notice(err.message); }
      finally { button.disabled = false; }
    }); input.focus();
  }
}

class ImagePicker extends Modal {
  constructor(plugin, view) { super(plugin.app); this.plugin = plugin; this.target = { view, filePath: view.file.path }; }
  onOpen() {
    this.modalEl.addClass('ml-picker');
    this.contentEl.createEl('h2', { text: '插入素材库图片' });
    this.contentEl.createEl('p', { text: `插入到「${this.target.view.file.basename}」，点击图片即可插入。` });
    const search = this.contentEl.createEl('input', { type: 'search', attr: { placeholder: '搜索图片…', 'aria-label': '搜索可插入图片' } });
    const label = this.contentEl.createEl('label', { cls: 'ml-cloud-auto', text: '查看整个笔记库 ' });
    const all = label.createEl('input', { type: 'checkbox' });
    const grid = this.contentEl.createDiv({ cls: 'ml-grid' });
    grid.style.setProperty('--ml-size', this.plugin.options.size + 'px');
    const draw = () => {
      grid.empty();
      const files = this.app.vault.getFiles().filter(f => kind(f) === 'image' && (all.checked || this.plugin.roots().some(root => within(f.path, root))) && f.path.toLowerCase().includes(search.value.toLowerCase()));
      if (!files.length) grid.createEl('p', { text: '没有匹配的图片，可勾选「查看整个笔记库」。' });
      for (const file of files.slice(0, 100)) {
        const button = grid.createEl('button', { cls: 'ml-tile', attr: { title: file.path } });
        const thumb = button.createDiv({ cls: 'ml-thumb' });
        thumb.createEl('img', { attr: { src: this.app.vault.getResourcePath(file), alt: file.basename, loading: 'lazy' } });
        button.createSpan({ text: file.name, cls: 'ml-name' });
        button.onclick = () => { if (this.plugin.insert([file], this.target)) this.close(); };
      }
      if (files.length > 100) grid.createEl('p', { text: '请搜索名称缩小范围，当前最多显示 100 张。' });
    };
    search.oninput = draw; all.onchange = draw; draw(); search.focus();
  }
}

async function renderCloudReference(plugin, source, el, ctx) {
  let closed = false, observer; const urls = new Set();
  const component = new MarkdownRenderChild(el);
  component.onunload = () => { closed = true; observer?.disconnect(); for (const url of urls) el.ownerDocument.defaultView.URL.revokeObjectURL(url); urls.clear(); };
  ctx.addChild(component);
  const box = el.createDiv({ cls: 'ml-reference' });
  const status = box.createEl('p', { text: '云端图片待加载…', cls: 'ml-status' });
  try {
    const ref = JSON.parse(source);
    if (!ref || typeof ref.connection !== 'string' || typeof ref.item !== 'string' || typeof ref.name !== 'string' || !cloudImage(ref.name)) throw new Error('图片引用格式不正确');
    const stored = plugin.options.connections.find(c => c.id === ref.connection && CLOUD_PROVIDERS[c.provider]);
    if (!stored) throw new Error('找不到对应的云端连接，请在素材库设置中恢复连接');
    const c = { ...stored, ...plugin.cloudSecrets.get(stored.id) };
    const item = { id: ref.item, name: ref.name, size: Number(ref.size) || 0, version: ref.version || '' };
    const win = el.ownerDocument.defaultView;
    let started = false;
    const load = async () => {
      if (closed || started) return; started = true; observer?.disconnect(); status.setText('正在加载云端图片…');
      try {
        const blob = await withOriginalPriority(plugin, () => cachedCloudImage(plugin, c, item, win, false));
        if (closed) return;
        box.querySelector('img')?.remove();
        for (const previous of urls) win.URL.revokeObjectURL(previous); urls.clear();
        const url = win.URL.createObjectURL(blob); urls.add(url);
        box.createEl('img', { attr: { src: url, alt: item.name, decoding: 'async' } }); status.remove();
      } catch (err) { if (!closed) { status.setText('云端图片：' + err.message); started = false; } }
    };
    const retry = box.createEl('button', { text: '重新加载', cls: 'ml-reference-retry' }); retry.onclick = () => { cloudCache(plugin).clear(); started = false; load(); };
    if (win.IntersectionObserver) { observer = new win.IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) load(); }); observer.observe(box); }
    else load();
  } catch (err) { status.setText('云端图片：' + err.message); }
}

class LibraryView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.selected = new Set(); this.scope = ''; this.query = ''; this.type = ''; this.limit = 100; }
  getViewType() { return VIEW; }
  getDisplayText() { return '素材库'; }
  getIcon() { return 'images'; }
  async onOpen() {
    this.contentEl.empty(); this.contentEl.addClass('ml-view');
    const header = this.contentEl.createDiv({ cls: 'ml-heading' });
    header.createEl('h2', { text: '素材库' });
    this.button(header, '云端素材', () => this.plugin.openCloud());
    this.button(header, '设置', () => this.plugin.openSettings());
    this.contentEl.createDiv({ cls: 'ml-subtitle', text: '收藏素材，让每次创作都能直接开始。' });
    const tools = this.contentEl.createDiv({ cls: 'ml-tools' });
    this.search = tools.createEl('input', { type: 'search', attr: { placeholder: '搜索名称或路径…', 'aria-label': '搜索素材' } });
    this.search.addEventListener('input', () => { this.query = this.search.value; this.limit = 100; this.refreshGrid(); });
    this.folders = tools.createEl('select', { attr: { 'aria-label': '素材分类' } });
    this.folders.onchange = () => { this.scope = this.folders.value; this.limit = 100; this.refreshGrid(); };
    const type = tools.createEl('select', { attr: { 'aria-label': '素材类型' } });
    for (const [value, text] of [['', '所有类型'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['document', 'PDF']]) type.createEl('option', { value, text });
    type.onchange = () => { this.type = type.value; this.limit = 100; this.refreshGrid(); };
    this.sort = tools.createEl('select', { attr: { 'aria-label': '排序方式' } });
    for (const [value, text] of [['newest', '最近导入 / 修改'], ['name', '按名称']]) this.sort.createEl('option', { value, text });
    this.sort.value = this.plugin.options.sort; this.sort.onchange = () => this.refreshGrid();
    const actions = this.contentEl.createDiv({ cls: 'ml-tools' });
    this.upload = actions.createEl('input', { type: 'file', attr: { multiple: '', accept: Object.values(TYPES).flat().map(x => '.' + x).join(',') } }); this.upload.style.display = 'none';
    this.importButton = this.button(actions, '导入素材', () => this.upload.click(), true);
    this.upload.onchange = async () => { await this.import([...this.upload.files]); this.upload.value = ''; };
    this.button(actions, '新建分类', () => new NameModal(this.app, '新建素材分类', async name => {
      const folder = folderPath(this.plugin.options.root + '/' + folderPath(name));
      await this.plugin.ensureFolder(folder); this.scope = folder; this.refresh();
    }).open());
    this.insertButton = this.button(actions, '插入所选', () => this.insertSelected());
    this.button(actions, '清空选择', () => { this.selected.clear(); this.refreshGrid(); });
    this.status = this.contentEl.createDiv({ cls: 'ml-status', attr: { 'aria-live': 'polite' } });
    this.grid = this.contentEl.createDiv({ cls: 'ml-grid' });
    this.more = this.button(this.contentEl, '加载更多', () => { this.limit += 100; this.refreshGrid(); });
    this.contentEl.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    this.contentEl.addEventListener('drop', e => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault(); e.stopPropagation(); this.import([...e.dataTransfer.files]);
    });
    this.refresh();
  }
  button(parent, text, action, primary = false) {
    const button = parent.createEl('button', { text, cls: primary ? 'mod-cta' : '' });
    button.onclick = async () => { try { await action(); } catch (err) { new Notice(err.message); } }; return button;
  }
  refresh() {
    if (!this.grid) return;
    const roots = this.plugin.roots();
    const folders = this.app.vault.getAllLoadedFiles().filter(f => Array.isArray(f.children) && roots.some(root => within(f.path, root))).map(f => f.path);
    this.folders.empty(); this.folders.createEl('option', { value: '', text: '全部素材目录' });
    this.folders.createEl('option', { value: '*', text: '整个笔记库' });
    for (const path of [...new Set([...roots, ...folders])].sort((a,b) => a.localeCompare(b, 'zh-CN'))) this.folders.createEl('option', { value: path, text: path });
    if (this.scope && this.scope !== '*' && ![...this.folders.options].some(o => o.value === this.scope)) this.scope = '';
    this.folders.value = this.scope; this.refreshGrid();
  }
  getFiles() {
    const roots = this.plugin.roots();
    return this.app.vault.getFiles().filter(f => kind(f) && (this.scope === '*' || (this.scope ? within(f.path, this.scope) : roots.some(root => within(f.path, root)))) &&
      (!this.type || kind(f) === this.type) && f.path.toLowerCase().includes(this.query.toLowerCase()))
      .sort((a,b) => this.sort.value === 'name' ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path));
  }
  refreshGrid() {
    this.grid.empty();
    for (const path of this.selected) if (!this.app.vault.getAbstractFileByPath(path)) this.selected.delete(path);
    const files = this.getFiles();
    this.contentEl.style.setProperty('--ml-size', this.plugin.options.size + 'px');
    this.status.setText(`${files.length} 个素材 · 已选 ${this.selected.size} 个 · 导入到：${this.importFolder()}。单击选择，双击预览，右键更多操作。`);
    this.insertButton.disabled = !this.selected.size;
    this.more.style.display = files.length > this.limit ? '' : 'none';
    if (!files.length) this.grid.createDiv({ cls: 'ml-empty', text: '还没有匹配的素材。可以导入或拖入文件，也可以切换到「整个笔记库」。' });
    for (const file of files.slice(0, this.limit)) {
      const tile = this.grid.createEl('button', { cls: 'ml-tile' + (this.selected.has(file.path) ? ' is-selected' : ''), attr: { title: file.path, 'aria-label': file.name, 'aria-pressed': String(this.selected.has(file.path)) } });
      const thumb = tile.createDiv({ cls: 'ml-thumb' });
      if (kind(file) === 'image') thumb.createEl('img', { attr: { src: this.app.vault.getResourcePath(file), alt: file.basename, loading: 'lazy', draggable: 'false' } });
      else { setIcon(thumb, { video: 'film', audio: 'music', document: 'file-text' }[kind(file)]); thumb.createSpan({ text: file.extension.toUpperCase() }); }
      if (this.plugin.options.showNames) tile.createSpan({ cls: 'ml-name', text: file.name });
      tile.onclick = () => { if (this.selected.has(file.path)) this.selected.delete(file.path); else this.selected.add(file.path); tile.toggleClass('is-selected', this.selected.has(file.path)); tile.setAttribute('aria-pressed', String(this.selected.has(file.path))); this.status.setText(`${files.length} 个素材 · 已选 ${this.selected.size} 个`); this.insertButton.disabled = !this.selected.size; };
      tile.ondblclick = () => this.preview(file);
      tile.oncontextmenu = e => {
        e.preventDefault(); const menu = new Menu();
        menu.addItem(i => i.setTitle('预览').setIcon('maximize').onClick(() => this.preview(file)));
        menu.addItem(i => i.setTitle('插入到笔记').setIcon('file-plus').onClick(() => this.plugin.insert([file])));
        menu.addItem(i => i.setTitle('复制嵌入链接').setIcon('copy').onClick(() => this.copy('!' + this.app.fileManager.generateMarkdownLink(file, this.plugin.lastNote?.file?.path || ''))));
        menu.addItem(i => i.setTitle('复制路径').setIcon('copy').onClick(() => this.copy(file.path)));
        menu.addItem(i => i.setTitle('在 Obsidian 中打开').setIcon('external-link').onClick(() => this.app.workspace.getLeaf('tab').openFile(file)));
        menu.showAtMouseEvent(e);
      };
    }
  }
  async copy(text) { try { await this.contentEl.ownerDocument.defaultView.navigator.clipboard.writeText(text); new Notice('已复制'); } catch (_) { new Notice('当前环境无法写入剪贴板'); } }
  importFolder() { return this.scope && this.scope !== '*' && within(this.scope, this.plugin.options.root) ? this.scope : this.plugin.options.root; }
  async import(files) {
    if (this.plugin.importing) { new Notice('正在导入，请稍候'); return; }
    this.importButton.disabled = true;
    try { const result = await this.plugin.importFiles(files, this.importFolder()); new Notice(`已导入 ${result.length} 个素材`); this.refresh(); }
    catch (err) { new Notice('导入失败：' + err.message); this.refresh(); }
    finally { this.importButton.disabled = false; }
  }
  insertSelected() { this.plugin.insert([...this.selected].map(p => this.app.vault.getAbstractFileByPath(p)).filter(Boolean)); }
  preview(file) {
    if (kind(file) === 'document') { this.app.workspace.getLeaf('tab').openFile(file); return; }
    const modal = new Modal(this.app); this.plugin.modals.add(modal);
    modal.onOpen = () => {
      modal.modalEl.addClass('ml-preview'); modal.contentEl.createEl('h3', { text: file.name });
      const type = kind(file); const media = modal.contentEl.createEl(type === 'image' ? 'img' : type, { attr: { src: this.app.vault.getResourcePath(file), alt: file.basename, controls: '' } });
      modal.onClose = () => { if (type !== 'image') { media.pause(); media.removeAttribute('src'); media.load(); } this.plugin.modals.delete(modal); };
      this.button(modal.contentEl, '插入到笔记', () => this.plugin.insert([file]), true);
    }; modal.open();
  }
}

function settingsUI(plugin, container) {
  container.empty(); container.createEl('h2', { text: '素材库设置' });
  const draft = JSON.parse(JSON.stringify(plugin.options));
  container.createEl('p', { text: '路径修改不会移动已有素材。修改后点击「保存设置」。' });
  new Setting(container).setName('云端连接').setDesc('支持多个 WebDAV 和 S3 连接，可分别设置账号与素材目录。').addButton(c => c.setButtonText('管理连接').onClick(() => thisCloudSettings(plugin)));
  new Setting(container).setName('云端预览并发数').setDesc('默认 4；网络较慢或服务限流时可调低。已加载图片会缓存到内存，不写入笔记库。').addSlider(c => c.setLimits(1, 8, 1).setValue(draft.previewConcurrency).setDynamicTooltip().onChange(v => draft.previewConcurrency = v));
  new Setting(container).setName('轻量 WebP 预览').setDesc('在内存中转换静态图片，原图和动画不改动。只改善预览渲染与再次查看，不减少首次原图传输。').addToggle(c => c.setValue(draft.convertPreviews).onChange(v => draft.convertPreviews = v));
  new Setting(container).setName('预览最长边（px）').addSlider(c => c.setLimits(200, 1000, 40).setValue(draft.previewEdge).setDynamicTooltip().onChange(v => draft.previewEdge = v));
  new Setting(container).setName('WebP 预览质量（%）').setDesc('数值越低通常越小；只影响缩略图，不影响查看原图。').addSlider(c => c.setLimits(50, 95, 1).setValue(draft.previewQuality).setDynamicTooltip().onChange(v => draft.previewQuality = v));
  new Setting(container).setName('素材库目录').addText(c => c.setValue(draft.root).onChange(v => draft.root = v));
  new Setting(container).setName('额外素材目录').setDesc('每行一个库内目录；用于展示原有素材，不会自动移动或复制。').addTextArea(c => c.setValue(draft.sources.join('\n')).onChange(v => draft.sources = v.split('\n').map(x => x.trim()).filter(Boolean)));
  new Setting(container).setName('缩略图尺寸').addSlider(c => c.setLimits(100, 300, 10).setValue(draft.size).setDynamicTooltip().onChange(v => draft.size = v));
  new Setting(container).setName('显示文件名').addToggle(c => c.setValue(draft.showNames).onChange(v => draft.showNames = v));
  new Setting(container).setName('默认排序').addDropdown(c => c.addOption('newest', '最近导入 / 修改').addOption('name', '按名称').setValue(draft.sort).onChange(v => draft.sort = v));
  new Setting(container).addButton(c => c.setButtonText('保存设置').setCta().onClick(async () => {
    c.setDisabled(true); try { draft.connections = plugin.options.connections; const next = plugin.validateOptions(draft); await plugin.saveData(next); plugin.options = next;
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW)) { leaf.view.sort.value = next.sort; leaf.view.refresh(); }
      for (const view of plugin.cloudViews || []) view.draw();
      new Notice('素材库设置已保存');
    } catch (err) { new Notice(err.message); } finally { c.setDisabled(false); }
  }));
}
class LibrarySettings extends PluginSettingTab { constructor(plugin) { super(plugin.app, plugin); this.plugin = plugin; } display() { settingsUI(this.plugin, this.containerEl); } }

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


module.exports = class MaterialLibraryPlugin extends Plugin {
  async onload() {
    try { this.options = this.validateOptions(await this.loadData()); } catch (_) { this.options = JSON.parse(JSON.stringify(DEFAULTS)); new Notice('素材库：设置格式异常，暂用默认值'); }
    this.modals = new Set(); this.cloudSecrets = new Map(); this.importing = false; this.lastNote = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.registerView(VIEW, leaf => new LibraryView(leaf, this));
    this.registerView(CLOUD_VIEW, leaf => new CloudBrowser(leaf, this));
    this.addSettingTab(new LibrarySettings(this));
    this.addRibbonIcon('images', '打开素材库', () => this.openLibrary());
    this.addCommand({ id: 'open', name: '打开素材库', callback: () => this.openLibrary() });
    this.addCommand({ id: 'settings', name: '打开设置', callback: () => this.openSettings() });
    this.addCommand({ id: 'cloud', name: '浏览云端素材', callback: () => this.openCloud() });
    this.addCommand({ id: 'insert-image', name: '插入素材库图片', editorCallback: (editor, view) => { this.lastNote = view; this.openImagePicker(view); } });
    this.addCommand({ id: 'insert-cloud-image', name: '插入云端图片', editorCallback: (editor, view) => { this.lastNote = view; this.openCloud(); } });
    this.registerMarkdownCodeBlockProcessor('material-image', (source, el, ctx) => renderCloudReference(this, source, el, ctx));
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      menu.addItem(i => i.setTitle('插入素材库图片').setIcon('images').onClick(() => { this.lastNote = view; this.openImagePicker(view); }));
      menu.addItem(i => i.setTitle('插入云端图片').setIcon('cloud').onClick(() => { this.lastNote = view; this.openCloud(); }));
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => { if (leaf?.view instanceof MarkdownView) this.lastNote = leaf.view; }));
    const refresh = () => { clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => { for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) leaf.view.refresh(); }, 200); };
    for (const event of ['create', 'delete', 'rename', 'modify']) this.registerEvent(this.app.vault.on(event, refresh));
    this.register(() => { clearTimeout(this.refreshTimer); for (const modal of this.modals) modal.close(); this.cloudSecrets.clear(); this.cloudPreviewCache?.clear(); });
  }
  validateOptions(raw) {
    const options = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), raw);
    options.root = folderPath(options.root);
    if (!Array.isArray(options.sources)) throw new Error('额外素材目录格式不正确');
    options.sources = [...new Set(options.sources.map(folderPath))];
    if (!Array.isArray(options.connections)) throw new Error('网盘连接配置不正确');
    options.connections = options.connections.map(migrateCloudConnection);
    if (!Number.isInteger(options.previewConcurrency) || options.previewConcurrency < 1 || options.previewConcurrency > 8) throw new Error('预览并发数必须在 1～8 之间');
    if (!Number.isInteger(options.previewEdge) || options.previewEdge < 200 || options.previewEdge > 1000 || !Number.isInteger(options.previewQuality) || options.previewQuality < 50 || options.previewQuality > 95) throw new Error('预览边长必须在 200～1000 之间，WebP 质量必须在 50～95 之间');
    options.convertPreviews = options.convertPreviews !== false;
    if (!Number.isInteger(options.size) || options.size < 100 || options.size > 300 || !['name', 'newest'].includes(options.sort)) throw new Error('尺寸或排序设置不正确');
    options.showNames = !!options.showNames; return options;
  }
  onunload() { this.app.workspace.detachLeavesOfType(VIEW); this.app.workspace.detachLeavesOfType(CLOUD_VIEW); }
  roots() { return [...new Set([this.options.root, ...this.options.sources])]; }
  async openCloud() {
    try {
      let leaf = this.app.workspace.getLeavesOfType(CLOUD_VIEW)[0];
      if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: CLOUD_VIEW, active: true }); }
      await this.app.workspace.revealLeaf(leaf);
    } catch (err) { new Notice('无法打开云端素材：' + err.message); }
  }
  async ensureFolder(path) {
    let current = '';
    for (const part of folderPath(path).split('/')) {
      current = current ? current + '/' + part : part;
      let file = this.app.vault.getAbstractFileByPath(current);
      if (!file) { try { await this.app.vault.createFolder(current); } catch (err) { if (!this.app.vault.getAbstractFileByPath(current)) throw err; } file = this.app.vault.getAbstractFileByPath(current); }
      if (!Array.isArray(file?.children)) throw new Error('目录被同名文件占用：' + current);
    }
  }
  async importFiles(files, folder) {
    if (this.importing) throw new Error('正在导入，请稍候');
    folder = folderPath(folder);
    if (!within(folder, this.options.root)) throw new Error('导入目录必须位于素材库目录内');
    this.importing = true;
    try {
      const supported = files.filter(f => kind({ extension: f.name.split('.').pop() }));
      if (supported.length !== files.length) new Notice(`跳过 ${files.length - supported.length} 个不支持的文件`);
      if (!supported.length) return [];
      await this.ensureFolder(folder); const imported = [];
      for (const file of supported) {
        const ext = file.name.split('.').pop().toLowerCase();
        const stem = file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim().slice(0, 100) || '素材';
        imported.push(await this.app.vault.createBinary(normalizePath(`${folder}/${stem}-${stamp()}.${ext}`), await file.arrayBuffer()));
      }
      return imported;
    } finally { this.importing = false; }
  }
  noteTarget(preferred) {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    const valid = view => view?.file && view.editor && leaves.some(leaf => leaf.view === view);
    if (preferred) {
      const view = preferred.view || preferred;
      return valid(view) && (!preferred.filePath || preferred.filePath === view.file.path) ? view : null;
    }
    const current = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (valid(current)) return current;
    if (valid(this.lastNote)) return this.lastNote;
    return leaves.length === 1 && valid(leaves[0].view) ? leaves[0].view : null;
  }
  insertText(text, preferred) {
    const view = this.noteTarget(preferred);
    if (!view) { new Notice('请在目标笔记中执行「插入素材库图片」或「插入云端图片」命令后再选择图片'); return false; }
    view.editor.replaceSelection(text); this.lastNote = view;
    if (view.leaf) this.app.workspace.revealLeaf(view.leaf);
    view.editor.focus?.(); return true;
  }
  insert(files, preferred) {
    const view = this.noteTarget(preferred);
    if (!view) return this.insertText('', preferred);
    const existing = files.filter(f => kind(f) && this.app.vault.getAbstractFileByPath(f.path));
    if (!existing.length) { new Notice('没有可插入的素材'); return false; }
    const links = existing.map(f => '!' + this.app.fileManager.generateMarkdownLink(f, view.file.path));
    const inserted = this.insertText('\n' + links.join('\n') + '\n', preferred || view);
    if (inserted) new Notice(`已插入 ${links.length} 个素材到「${view.file.basename}」`);
    return inserted;
  }
  async cloudFilePath(c, item, win) {
    const identity = JSON.stringify([c.id, c.provider, c.endpoint, c.username || '', c.bucket || '', item.id, item.size || 0, item.version || '']);
    const hash = Array.from(new Uint8Array(await win.crypto.subtle.digest('SHA-256', new win.TextEncoder().encode(identity))), b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    const ext = item.name.split('.').pop().toLowerCase();
    const stem = item.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || '图片';
    const folder = normalizePath(this.options.root + '/云端导入');
    const path = normalizePath(`${folder}/${stem}-${hash}.${ext}`);
    return { folder, path };
  }
  async readLocalCloudImage(c, item, win) {
    if (!this.app.vault.getAbstractFileByPath || !this.app.vault.readBinary) return null;
    const { path } = await this.cloudFilePath(c, item, win);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || kind(file) !== 'image' || file.stat?.size === 0) return null;
    const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' }[file.extension.toLowerCase()] || 'image/' + file.extension.toLowerCase();
    return new win.Blob([await this.app.vault.readBinary(file)], { type });
  }
  async downloadCloudFile(c, item, win) {
    const { folder, path } = await this.cloudFilePath(c, item, win);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      if (kind(existing) !== 'image' || existing.stat?.size === 0) throw new Error('本地目标文件异常，请先检查：' + path);
      return existing;
    }
    this.downloadTasks ||= new Map();
    if (this.downloadTasks.has(path)) return this.downloadTasks.get(path);
    const task = (async () => {
      await this.ensureFolder(folder);
      const blob = await withOriginalPriority(this, () => cachedCloudImage(this, c, item, win, false));
      const bytes = await blob.arrayBuffer();
      if (!bytes.byteLength) throw new Error('图片内容为空，未保存到本地');
      // Another operation may have created the file while the image was downloading.
      const current = this.app.vault.getAbstractFileByPath(path);
      if (current) {
        if (kind(current) !== 'image' || current.stat?.size === 0) throw new Error('本地目标文件异常：' + path);
        return current;
      }
      return this.app.vault.createBinary(path, bytes);
    })();
    this.downloadTasks.set(path, task);
    try { return await task; } finally { if (this.downloadTasks.get(path) === task) this.downloadTasks.delete(path); }
  }
  async insertCloud(c, item) {
    if (!CLOUD_PROVIDERS[c.provider] || !cloudImage(item.name)) { new Notice('只能插入有效的云端图片'); return false; }
    const view = this.noteTarget();
    if (!view) return this.insertText('');
    const target = { view, filePath: view.file.path };
    try {
      new Notice('正在保存原图到本地素材库…');
      const file = await this.downloadCloudFile(c, item, this.app.workspace.containerEl?.ownerDocument.defaultView || globalThis.window);
      const inserted = this.insert([file], target);
      if (!inserted) new Notice('图片已保存到本地，但目标笔记已关闭或切换，请从素材库重新插入：' + file.path, 8000);
      return inserted;
    } catch (err) { new Notice('下载或插入失败：' + err.message); return false; }
  }
  openImagePicker(view = this.noteTarget()) {
    if (!view) { new Notice('请先打开目标笔记'); return; }
    const modal = new ImagePicker(this, view); this.modals.add(modal); modal.onClose = () => this.modals.delete(modal); modal.open();
  }
  async openLibrary() {
    try { let leaf = this.app.workspace.getLeavesOfType(VIEW)[0]; if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW, active: true }); } await this.app.workspace.revealLeaf(leaf); }
    catch (err) { new Notice('无法打开素材库：' + err.message); }
  }
  openSettings() { const modal = new Modal(this.app); this.modals.add(modal); modal.onOpen = () => settingsUI(this, modal.contentEl); modal.onClose = () => this.modals.delete(modal); modal.open(); }
};
