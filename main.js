const { app, BrowserWindow, ipcMain, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const UA = 'TuskloLauncher/1.0';
const root = path.join(app.getPath('userData'), 'game');
const cfgFile = path.join(app.getPath('userData'), 'config.json');
let cfg = {
  profile: { name: 'main', version: '1.20.1', loader: 'fabric' },
  installs: [{ id: 'main', name: 'Основная', version: '1.20.1', loader: 'fabric' }], sel: 'main',
  mode: 'offline', nick: 'Player', account: null, curseKey: '', ram: 4,
  lang: 'ru', closeOnLaunch: true,
};
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')) }; } catch {}
const DEFAULT_CF_KEY = '$2a$10$97RosohuBjHvm8dPXRBED.tWFuiQcJrKVIGQq0so6Fl1EZ2o6t3Ja';
if (!cfg.curseKey) cfg.curseKey = DEFAULT_CF_KEY;
const save = () => fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

let win;
const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);

const nf = (u, o) => (net && net.fetch ? net.fetch(u, o) : fetch(u, o));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async (url, headers = {}) => {
  for (let a = 1; ; a++) {
    try {
      const r = await nf(url, { headers: { 'User-Agent': UA, ...headers } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (a >= 3) throw new Error(`${e.message} (${url})`);
      await sleep(500 * a);
    }
  }
};
const dl = async (url, file) => {
  for (let a = 1; ; a++) {
    try {
      const r = await nf(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer()));
      fs.renameSync(file + '.part', file);
      return;
    } catch (e) {
      if (a >= 4) throw new Error(`${e.message} (${url})`);
      await sleep(600 * a);
    }
  }
};
const gameDir = () => path.join(root, 'instances', cfg.profile.name);
const modsDir = () => {
  const d = path.join(gameDir(), 'mods');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const packsDir = () => {
  const d = path.join(gameDir(), 'resourcepacks');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const CF_LOADER = { fabric: 4, forge: 1, quilt: 5, neoforge: 6 };

/* ---------- Modrinth ---------- */
async function mrSearch(q, offset, kind = 'mod') {
  const { version, loader } = cfg.profile;
  const facets = [[`project_type:${kind === 'mod' ? 'mod' : 'resourcepack'}`], [`versions:${version}`]];
  if (kind === 'mod' && loader !== 'vanilla') facets.push([`categories:${loader}`]);
  const u = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&limit=20&offset=${offset}&index=${q ? 'relevance' : 'downloads'}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const j = await get(u);
  return j.hits.map(h => ({
    id: h.project_id, src: 'modrinth', title: h.title, desc: h.description,
    icon: h.icon_url, downloads: h.downloads, author: h.author,
  }));
}
async function mrInstall(id, kind = 'mod', seen = new Set()) {
  if (seen.has(id)) return [];
  seen.add(id);
  const { version, loader } = cfg.profile;
  let qs = `game_versions=${encodeURIComponent(JSON.stringify([version]))}`;
  if (kind === 'mod' && loader !== 'vanilla') qs += `&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
  const vs = await get(`https://api.modrinth.com/v2/project/${id}/version?${qs}`);
  if (!vs.length) throw new Error(`Нет версии мода для ${version} / ${loader}`);
  const ver = vs[0];
  const f = ver.files.find(x => x.primary) || ver.files[0];
  await dl(f.url, path.join(kind === 'mod' ? modsDir() : packsDir(), f.filename));
  let out = [f.filename];
  for (const d of kind === 'mod' ? ver.dependencies || [] : []) {
    if (d.dependency_type === 'required' && d.project_id) {
      try { out = out.concat(await mrInstall(d.project_id, 'mod', seen)); } catch {}
    }
  }
  return out;
}

/* ---------- CurseForge ---------- */
const cf = (p) => {
  if (!cfg.curseKey) throw new Error('Укажи API-ключ CurseForge в настройках');
  return get('https://api.curseforge.com/v1' + p, { 'x-api-key': cfg.curseKey });
};
async function cfSearch(q, offset, kind = 'mod') {
  const { version, loader } = cfg.profile;
  let p = `/mods/search?gameId=432&classId=${kind === 'mod' ? 6 : 12}&pageSize=20&index=${offset}&sortField=${q ? 1 : 2}&sortOrder=desc&gameVersion=${version}`;
  if (q) p += `&searchFilter=${encodeURIComponent(q)}`;
  if (kind === 'mod' && CF_LOADER[loader]) p += `&modLoaderType=${CF_LOADER[loader]}`;
  const j = await cf(p);
  return j.data.map(m => ({
    id: String(m.id), src: 'curseforge', title: m.name, desc: m.summary,
    icon: m.logo && m.logo.thumbnailUrl, downloads: m.downloadCount,
    author: (m.authors && m.authors[0] && m.authors[0].name) || '',
  }));
}
async function cfInstall(id, kind = 'mod') {
  const { version, loader } = cfg.profile;
  let p = `/mods/${id}/files?gameVersion=${version}&pageSize=1`;
  if (kind === 'mod' && CF_LOADER[loader]) p += `&modLoaderType=${CF_LOADER[loader]}`;
  const j = await cf(p);
  const f = j.data[0];
  if (!f) throw new Error(`Нет версии мода для ${version} / ${loader}`);
  if (!f.downloadUrl) throw new Error('Автор отключил скачивание вне сайта CurseForge');
  await dl(f.downloadUrl, path.join(kind === 'mod' ? modsDir() : packsDir(), f.fileName));
  return [f.fileName];
}

/* ---------- Fabric / Quilt ---------- */
async function ensureLoader(mc, kind) {
  const base = kind === 'fabric'
    ? 'https://meta.fabricmc.net/v2/versions/loader/'
    : 'https://meta.quiltmc.org/v3/versions/loader/';
  const list = await get(base + mc);
  if (!list.length) throw new Error(`${kind} не поддерживает ${mc}`);
  const prof = await get(`${base}${mc}/${list[0].loader.version}/profile/json`);
  const dir = path.join(root, 'versions', prof.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, prof.id + '.json'), JSON.stringify(prof));
  return prof.id;
}

/* ---------- Auth ---------- */
async function getAuth() {
  if (cfg.mode === 'ms' && cfg.account) {
    const am = new Auth('select_account');
    const x = await am.refresh(cfg.account);
    const t = await x.getMinecraft();
    cfg.account = x.save();
    save();
    return t.mclc();
  }
  return Authenticator.getAuth(cfg.nick || 'Player');
}

/* ---------- Язык игры ---------- */
const GAME_LANG = { ru: 'ru_ru', en: 'en_us', uk: 'uk_ua' };
function setGameLang() {
  const f = path.join(gameDir(), 'options.txt');
  let t = '';
  try { t = fs.readFileSync(f, 'utf8'); } catch {}
  const line = 'lang:' + (GAME_LANG[cfg.lang] || 'en_us');
  t = /^lang:[^\r\n]*/m.test(t) ? t.replace(/^lang:[^\r\n]*/m, line) : (t && !t.endsWith('\n') ? t + '\n' : t) + line + '\n';
  fs.writeFileSync(f, t);
}

/* ---------- IPC ---------- */
ipcMain.handle('win', (e, a) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (a === 'min') w.minimize();
  else if (a === 'max') (w.isMaximized() ? w.unmaximize() : w.maximize());
  else if (a === 'close') w.close();
});
ipcMain.handle('state', () => cfg);
ipcMain.handle('set', (_, patch) => {
  cfg = { ...cfg, ...patch, profile: { ...cfg.profile, ...(patch.profile || {}) } };
  save();
  return cfg;
});
ipcMain.handle('versions', async () => {
  const j = await get('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  return j.versions.map(v => ({ id: v.id, type: v.type }));
});

/* ---------- Скачивание версий ---------- */
const OS = { win32: 'windows', darwin: 'osx' }[process.platform] || 'linux';
const allowed = l => !l.rules || l.rules.reduce(
  (a, r) => (!r.features && (!r.os || r.os.name === OS)) ? r.action === 'allow' : a, false);
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}
const fetchTo = async (url, file) => {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await dl(url, file);
};
async function downloadVersion(id) {
  const man = await get('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  const entry = man.versions.find(v => v.id === id);
  if (!entry) throw new Error('Версия не найдена: ' + id);
  const vj = await get(entry.url);
  const vdir = path.join(root, 'versions', id);
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, id + '.json'), JSON.stringify(vj));
  const idx = await get(vj.assetIndex.url);
  fs.mkdirSync(path.join(root, 'assets', 'indexes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'indexes', vj.assetIndex.id + '.json'), JSON.stringify(idx));
  const jobs = [];
  for (const l of vj.libraries || []) {
    const a = l.downloads && l.downloads.artifact;
    if (allowed(l) && a && a.url) jobs.push([a.url, path.join(root, 'libraries', a.path)]);
  }
  for (const o of Object.values(idx.objects)) {
    const p = o.hash.slice(0, 2);
    jobs.push([`https://resources.download.minecraft.net/${p}/${o.hash}`, path.join(root, 'assets', 'objects', p, o.hash)]);
  }
  jobs.push([vj.downloads.client.url, path.join(vdir, id + '.jar')]); // последним: по нему определяем «скачана»
  let done = 0;
  await pool(jobs.slice(0, -1), 10, async ([u, f]) => { await fetchTo(u, f); send('dl', { id, done: ++done, total: jobs.length }); });
  await fetchTo(...jobs[jobs.length - 1]);
  send('dl', { id, done: jobs.length, total: jobs.length });
}

/* ---------- Java ---------- */
const JPLAT = { 'win32-x64': 'windows-x64', 'win32-arm64': 'windows-arm64', 'win32-ia32': 'windows-x86',
  'darwin-x64': 'mac-os', 'darwin-arm64': 'mac-os-arm64', 'linux-x64': 'linux', 'linux-ia32': 'linux-i386' }[process.platform + '-' + process.arch];
const javaBin = d => {
  const b = process.platform === 'win32' ? path.join(d, 'bin', 'javaw.exe')
    : process.platform === 'darwin' ? path.join(d, 'jre.bundle', 'Contents', 'Home', 'bin', 'java')
    : path.join(d, 'bin', 'java');
  return fs.existsSync(b) ? b : null;
};
async function ensureJava(vid) {
  try {
    const vf = path.join(root, 'versions', vid, vid + '.json');
    if (!fs.existsSync(vf) || !JPLAT) return null;
    const comp = (JSON.parse(fs.readFileSync(vf, 'utf8')).javaVersion || {}).component || 'jre-legacy';
    const dir = path.join(root, 'runtime', comp);
    if (fs.existsSync(path.join(dir, '.ok'))) return javaBin(dir);
    send('log', 'Скачивание Java (' + comp + ')…');
    const all = await get('https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json');
    const e = ((all[JPLAT] || {})[comp] || [])[0];
    if (!e) return null;
    const man = await get(e.manifest.url);
    const files = Object.entries(man.files).filter(([, f]) => f.type === 'file');
    let done = 0;
    await pool(files, 10, async ([rel, f]) => {
      const t = path.join(dir, rel);
      await fetchTo(f.downloads.raw.url, t);
      if (f.executable) { try { fs.chmodSync(t, 0o755); } catch {} }
      send('dl', { id: 'java', done: ++done, total: files.length });
    });
    for (const [rel, f] of Object.entries(man.files)) {
      if (f.type !== 'link') continue;
      try { const t = path.join(dir, rel); fs.mkdirSync(path.dirname(t), { recursive: true }); if (!fs.existsSync(t)) fs.symlinkSync(f.target, t); } catch {}
    }
    fs.writeFileSync(path.join(dir, '.ok'), e.version.name);
    return javaBin(dir);
  } catch (err) {
    send('log', 'Java не скачана (' + err.message + '), используем системную');
    return null;
  }
}
ipcMain.handle('installed', () => {
  const d = path.join(root, 'versions');
  try { return fs.readdirSync(d).filter(v => fs.existsSync(path.join(d, v, v + '.jar'))); } catch { return []; }
});
ipcMain.handle('download', async (_, { id, loader }) => {
  await downloadVersion(id);
  await ensureJava(id);
  if (loader && loader !== 'vanilla') await ensureLoader(id, loader);
});
ipcMain.handle('select', (_, { installs, sel }) => {
  cfg.installs = installs; cfg.sel = sel;
  const i = installs.find(x => x.id === sel) || installs[0];
  cfg.profile = { name: i.id, version: i.version, loader: i.loader };
  save();
  return cfg;
});
ipcMain.handle('search', async (_, { src, q, offset, kind }) =>
  src === 'modrinth' ? mrSearch(q, offset || 0, kind) : cfSearch(q, offset || 0, kind));
ipcMain.handle('install', async (_, { src, id, kind }) =>
  src === 'modrinth' ? mrInstall(id, kind) : cfInstall(id, kind));
ipcMain.handle('mods', (_, kind) => {
  const dir = kind === 'resourcepack' ? packsDir() : modsDir();
  return fs.readdirSync(dir).filter(f => f.endsWith(kind === 'resourcepack' ? '.zip' : '.jar'));
});
ipcMain.handle('remove', (_, { kind, f }) => {
  fs.unlinkSync(path.join(kind === 'resourcepack' ? packsDir() : modsDir(), path.basename(f)));
});
ipcMain.handle('login', async () => {
  const am = new Auth('select_account');
  const x = await am.launch('electron');
  const t = await x.getMinecraft();
  cfg.account = x.save();
  cfg.nick = t.profile.name;
  cfg.mode = 'ms';
  save();
  return cfg;
});
ipcMain.handle('folder', () => { fs.mkdirSync(gameDir(), { recursive: true }); shell.openPath(gameDir()); });
ipcMain.handle('play', async () => {
  const p = cfg.profile;
  send('log', 'Подготовка…');
  const custom = p.loader !== 'vanilla' ? await ensureLoader(p.version, p.loader) : null;
  const authorization = await getAuth();
  const javaPath = await ensureJava(p.version);
  fs.mkdirSync(gameDir(), { recursive: true });
  setGameLang();
  const l = new Client();
  l.on('progress', e => send('progress', e));
  l.on('debug', m => send('log', String(m)));
  let opened = false;
  l.on('data', m => {
    send('log', String(m));
    if (opened) return;
    opened = true; gameRunning = true;
    if (cfg.closeOnLaunch) setTimeout(() => win && !win.isDestroyed() && win.close(), 3000);
  });
  l.on('close', c => {
    gameRunning = false;
    if (win && !win.isDestroyed()) return send('closed', c);
    if (!c) return app.quit();
    createWindow(); // игра упала, пока лаунчер был закрыт: показываем его снова
    win.webContents.once('did-finish-load', () => send('crashed', c));
  });
  l.launch({
    authorization, root, ...(javaPath ? { javaPath } : {}),
    version: { number: p.version, type: 'release', ...(custom ? { custom } : {}) },
    memory: { max: cfg.ram + 'G', min: '1G' },
    overrides: { gameDirectory: gameDir() },
  }).catch(e => send('log', 'Ошибка запуска: ' + e.message));
});

let gameRunning = false;
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 900, minHeight: 600,
    backgroundColor: '#1e1e1f', frame: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile('index.html');
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (!gameRunning) app.quit(); });
