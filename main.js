const { app, BrowserWindow, ipcMain, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const UA = 'TuskloLauncher/1.0';
const crypto = require('crypto');
const root = path.join(app.getPath('userData'), 'game');
const cfgFile = path.join(app.getPath('userData'), 'config.json');
const defaultCfg = {
  profile: { name: 'main', version: '1.20.1', loader: 'fabric' },
  installs: [{ id: 'main', name: 'Основная', version: '1.20.1', loader: 'fabric' }], sel: 'main',
  mode: 'offline', nick: 'Player', account: null, accounts: [], activeAccountId: null,
  onboardingComplete: false, curseKey: '', ram: 4,
  lang: 'ru', closeOnLaunch: true, javaPreset: 'default', javaArgs: '', playBackground: null,
};
let storedCfg = {};
let configExisted = fs.existsSync(cfgFile);
try { storedCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch {}
let cfg = { ...defaultCfg, ...storedCfg, profile: { ...defaultCfg.profile, ...(storedCfg.profile || {}) } };
// Миграция старого формата: существующий аккаунт сохраняется при обновлении лаунчера.
if (configExisted && !Array.isArray(storedCfg.accounts)) {
  const oldMode = storedCfg.mode === 'ms' && storedCfg.account ? 'ms' : 'offline';
  cfg.accounts = [{
    id: crypto.randomUUID(), mode: oldMode, nick: storedCfg.nick || 'Player',
    ...(oldMode === 'ms' ? { auth: storedCfg.account, uuid: storedCfg.account?.profile?.id || null } : {}),
  }];
  cfg.activeAccountId = cfg.accounts[0].id;
  cfg.onboardingComplete = true;
}
if (!Array.isArray(cfg.accounts)) cfg.accounts = [];
if (cfg.accounts.length && !cfg.accounts.some(a => a.id === cfg.activeAccountId)) cfg.activeAccountId = cfg.accounts[0].id;
function syncLegacyAccountFields() {
  const active = cfg.accounts.find(a => a.id === cfg.activeAccountId);
  if (!active) return;
  cfg.mode = active.mode;
  cfg.nick = active.nick;
  cfg.account = active.mode === 'ms' ? active.auth : null;
  cfg.onboardingComplete = true;
}
syncLegacyAccountFields();
function publicConfig() {
  const out = { ...cfg, accounts: cfg.accounts.map(({ id, mode, nick }) => ({ id, mode, nick })) };
  delete out.account;
  return out;
}
// Ключ CurseForge API. Чтобы заменить, поменяй значение здесь.
const CF_KEY = '$2a$10$97RosohuBjHvm8dPXRBED.tWFuiQcJrKVIGQq0so6Fl1EZ2o6t3Ja';
const save = () => { fs.mkdirSync(path.dirname(cfgFile), { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); };
const BACKGROUNDS = ['wallpaper-1.jpg','wallpaper-2.jpg','wallpaper-3.jpg','wallpaper-4.jpg','wallpaper-5.jpg'];
function rotateBackground() {
  const choices = BACKGROUNDS.filter(name => name !== cfg.playBackground);
  cfg.playBackground = choices[Math.floor(Math.random() * choices.length)] || BACKGROUNDS[0];
  save();
}

let win;
const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);

const nf = (u, o) => (net && net.fetch ? net.fetch(u, o) : fetch(u, o));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async (url, headers = {}, tries = 3) => {
  for (let a = 1; ; a++) {
    try {
      const r = await nf(url, { headers: { 'User-Agent': UA, ...headers } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (a >= tries) throw new Error(`${e.message} (${url})`);
      await sleep(500 * a);
    }
  }
};
const dl = async (url, file, tries = 4) => {
  for (let a = 1; ; a++) {
    try {
      const r = await nf(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer()));
      fs.renameSync(file + '.part', file);
      return;
    } catch (e) {
      if (a >= tries) throw new Error(`${e.message} (${url})`);
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
const cf = async (p) => {
  try { return await get('https://api.curseforge.com/v1' + p, { 'x-api-key': CF_KEY }); }
  catch (e) { throw new Error('CurseForge недоступен, попробуй Modrinth. ' + e.message); }
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

/* ---------- Fabric / Quilt (с зеркалом на случай блокировки fabricmc.net) ---------- */
let mirrorFirst = false;
async function tryUrls(urls, fn) {
  const list = mirrorFirst ? [...urls].reverse() : urls;
  let last;
  for (const u of list) {
    try {
      const r = await fn(u);
      if (u !== urls[0]) mirrorFirst = true; // основной адрес недоступен: дальше идём сразу в зеркало
      return r;
    } catch (e) { last = e; }
  }
  throw last;
}
const MIRROR = 'https://bmclapi2.bangbang93.com';
async function ensureLoader(mc, kind) {
  const bases = kind === 'fabric'
    ? ['https://meta.fabricmc.net/v2/versions/loader/', MIRROR + '/fabric-meta/v2/versions/loader/']
    : ['https://meta.quiltmc.org/v3/versions/loader/', MIRROR + '/quilt-meta/v3/versions/loader/'];
  const list = await tryUrls(bases, b => get(b + mc, {}, 2));
  if (!list.length) throw new Error(`${kind} не поддерживает ${mc}`);
  const lv = list[0].loader.version;
  const prof = await tryUrls(bases, b => get(`${b}${mc}/${lv}/profile/json`, {}, 2));
  // библиотеки загрузчика качаем заранее, иначе лаунчер упрётся в maven.fabricmc.net
  const libs = (prof.libraries || []).filter(l => !l.downloads && l.name);
  await pool(libs, 6, async l => {
    const [g, a, v, c] = l.name.split(':');
    const rel = `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${c ? '-' + c : ''}.jar`;
    const file = path.join(root, 'libraries', rel);
    if (fs.existsSync(file)) return;
    const base = (l.url || 'https://maven.fabricmc.net/').replace(/\/?$/, '/');
    await tryUrls([base + rel, MIRROR + '/maven/' + rel], u => dl(u, file, 2));
  });
  const dir = path.join(root, 'versions', prof.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, prof.id + '.json'), JSON.stringify(prof));
  return prof.id;
}

/* ---------- Auth ---------- */
async function getAuth() {
  const active = cfg.accounts.find(a => a.id === cfg.activeAccountId);
  if (!active) throw new Error('Сначала создай или выбери аккаунт.');
  if (active.mode === 'ms' && active.auth) {
    const am = new Auth('select_account');
    const x = await am.refresh(active.auth);
    const t = await x.getMinecraft();
    active.auth = x.save();
    active.nick = t.profile.name;
    syncLegacyAccountFields();
    save();
    return t.mclc();
  }
  return Authenticator.getAuth(active.nick || 'Player');
}

/* ---------- Аргументы JVM ---------- */
const JAVA_PRESETS = {
  default: '',
  optimize: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1',
  mods: '-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:+ParallelRefProcEnabled -XX:+DisableExplicitGC -XX:MaxGCPauseMillis=150 -XX:G1NewSizePercent=40 -XX:G1MaxNewSizePercent=50 -XX:G1HeapRegionSize=16M -XX:G1ReservePercent=15 -XX:InitiatingHeapOccupancyPercent=20 -XX:+UseStringDeduplication',
  lowend: '-XX:+UseSerialGC -XX:MinHeapFreeRatio=10 -XX:MaxHeapFreeRatio=30',
};
const javaArgs = () => {
  const s = cfg.javaPreset === 'custom' ? (cfg.javaArgs || '') : (JAVA_PRESETS[cfg.javaPreset] || '');
  return (s.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(a => a.replace(/"/g, ''));
};
ipcMain.handle('javaPresets', () => JAVA_PRESETS);

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
ipcMain.handle('state', () => publicConfig());
ipcMain.handle('set', (_, patch) => {
  const safePatch = { ...patch };
  delete safePatch.accounts; delete safePatch.account; delete safePatch.activeAccountId;
  cfg = { ...cfg, ...safePatch, profile: { ...cfg.profile, ...(safePatch.profile || {}) } };
  save();
  return publicConfig();
});
ipcMain.handle('createOfflineAccount', (_, nickname) => {
  const nick = String(nickname || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) throw new Error('Ник должен содержать 3–16 символов: латинские буквы, цифры или _.');
  const account = { id: crypto.randomUUID(), mode: 'offline', nick };
  cfg.accounts.push(account);
  cfg.activeAccountId = account.id;
  syncLegacyAccountFields(); save();
  return publicConfig();
});
ipcMain.handle('switchAccount', (_, id) => {
  if (!cfg.accounts.some(a => a.id === id)) throw new Error('Аккаунт не найден.');
  cfg.activeAccountId = id;
  syncLegacyAccountFields(); save();
  return publicConfig();
});
ipcMain.handle('removeAccount', (_, id) => {
  if (cfg.accounts.length <= 1) throw new Error('Нельзя удалить последний аккаунт.');
  cfg.accounts = cfg.accounts.filter(a => a.id !== id);
  if (cfg.activeAccountId === id) cfg.activeAccountId = cfg.accounts[0].id;
  syncLegacyAccountFields(); save();
  return publicConfig();
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
  const uuid = t.profile.id || null;
  let account = cfg.accounts.find(a => uuid && a.uuid === uuid);
  if (account) {
    account.auth = x.save(); account.nick = t.profile.name; account.mode = 'ms';
  } else {
    account = { id: crypto.randomUUID(), mode: 'ms', nick: t.profile.name, uuid, auth: x.save() };
    cfg.accounts.push(account);
  }
  cfg.activeAccountId = account.id;
  syncLegacyAccountFields(); save();
  return publicConfig();
});
const crashFile = path.join(app.getPath('userData'), 'last-crash.json');
let lastCrashReport = null;
try { lastCrashReport = JSON.parse(fs.readFileSync(crashFile, 'utf8')); } catch {}
function readTail(file, maxLines = 240) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-maxLines).join('\n'); } catch { return ''; }
}
function extractCrashSuggestions(logText) {
  const found = new Map();
  // Fabric Loader часто прямо перечисляет пакеты, которые необходимо установить.
  const installLine = /^\s*-\s*Install\s+([a-z0-9][a-z0-9_.-]*)(?:\s*,\s*(.*?))?\s*\.?\s*$/gim;
  for (const m of logText.matchAll(installLine)) {
    const id = m[1].toLowerCase();
    if (!['minecraft', 'fabricloader', 'quilt_loader', 'java', 'forge', 'neoforge'].includes(id)) {
      found.set(id, { id, reason: (m[2] || 'Требуется загрузчиком').trim() });
    }
  }
  // Дополнительный разбор диагностического блока обязательных зависимостей.
  const marker = logText.toLowerCase().indexOf('missing or unsupported mandatory dependencies');
  if (marker >= 0) {
    const block = logText.slice(marker, marker + 12000);
    for (const m of block.matchAll(/Mod ID:\s*['"]?([a-z0-9][a-z0-9_.-]*)/gi)) {
      const id = m[1].toLowerCase();
      if (!['minecraft', 'fabricloader', 'quilt_loader', 'java', 'forge', 'neoforge'].includes(id) && !found.has(id)) {
        found.set(id, { id, reason: 'Указан в списке обязательных зависимостей' });
      }
    }
  }
  return [...found.values()].filter(item => {
    try { return !fs.readdirSync(modsDir()).some(f => f.toLowerCase().startsWith(item.id.toLowerCase() + '-') || f.toLowerCase().startsWith(item.id.toLowerCase() + '.')); }
    catch { return true; }
  }).slice(0, 12);
}
function describeCrash(code, logText, launchError) {
  if (launchError) return launchError;
  if (/OutOfMemoryError|Could not reserve enough space|There is insufficient memory/i.test(logText)) return 'Похоже, игре не хватило оперативной памяти. Проверь выделенную память и закрой лишние программы.';
  if (/UnsupportedClassVersionError|class file version/i.test(logText)) return 'Похоже, выбрана неподходящая версия Java для этой сборки.';
  if (/ModResolutionException|incompatible mod set|Missing or unsupported mandatory dependencies/i.test(logText)) return 'Загрузчик обнаружил несовместимость или недостающие зависимости модов.';
  if (/Failed to download|Could not download|SSLHandshakeException/i.test(logText)) return 'Не удалось загрузить один из файлов игры или библиотеки. Проверь подключение к интернету и попробуй исправление.';
  return `Minecraft завершился с кодом ${code ?? 'неизвестно'}. В логе не удалось однозначно определить причину.`;
}
function createCrashReport(code, runtimeLines = [], launchError = '') {
  const instDir = gameDir();
  const crashDir = path.join(instDir, 'crash-reports');
  let reportPath = '';
  try {
    reportPath = fs.readdirSync(crashDir).filter(f => f.endsWith('.txt'))
      .map(f => ({ f, t: fs.statSync(path.join(crashDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]?.f || '';
  } catch {}
  const crashText = reportPath ? readTail(path.join(crashDir, reportPath), 320) : '';
  const latestText = readTail(path.join(instDir, 'logs', 'latest.log'), 260);
  const runtimeText = runtimeLines.slice(-160).join('\n');
  const logText = [crashText, latestText, runtimeText].filter(Boolean).join('\n\n');
  const suggestions = extractCrashSuggestions(logText);
  const report = {
    code: code ?? null, instance: cfg.profile.name, version: cfg.profile.version,
    loader: cfg.profile.loader, createdAt: new Date().toISOString(),
    message: describeCrash(code, logText, launchError), suggestions,
    logTail: logText.slice(-16000), crashReport: reportPath || null,
  };
  lastCrashReport = report;
  try { fs.writeFileSync(crashFile, JSON.stringify(report, null, 2)); } catch {}
  return report;
}
function publishCrash(report) {
  if (win && !win.isDestroyed()) {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => send('crashReport', report));
    else send('crashReport', report);
  } else {
    createWindow();
    win.webContents.once('did-finish-load', () => send('crashReport', report));
  }
}
ipcMain.handle('lastCrash', () => lastCrashReport);
ipcMain.handle('clearCrash', () => {
  lastCrashReport = null;
  try { fs.unlinkSync(crashFile); } catch {}
  return true;
});
ipcMain.handle('repair', async () => {
  if (!lastCrashReport) throw new Error('Нет отчёта об ошибке.');
  if (!lastCrashReport.suggestions.length) throw new Error('В логе не найдены точные названия недостающих модов. Открой лог ошибки для диагностики.');
  const results = [];
  for (const suggestion of lastCrashReport.suggestions) {
    send('repairProgress', `Поиск ${suggestion.id}…`);
    try {
      const project = await get(`https://api.modrinth.com/v2/project/${encodeURIComponent(suggestion.id)}`);
      if (project.project_type !== 'mod') throw new Error('На Modrinth найден проект, но это не мод.');
      const files = await mrInstall(project.id, 'mod');
      results.push({ id: suggestion.id, ok: true, files });
    } catch (error) {
      results.push({ id: suggestion.id, ok: false, error: error.message });
    }
  }
  const installed = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  lastCrashReport.repairResults = results;
  try { fs.writeFileSync(crashFile, JSON.stringify(lastCrashReport, null, 2)); } catch {}
  return { installed, failed, allOk: failed.length === 0 };
});
ipcMain.handle('folder', () => { fs.mkdirSync(gameDir(), { recursive: true }); shell.openPath(gameDir()); });
ipcMain.handle('play', async () => {
  if (!cfg.accounts.length || !cfg.activeAccountId) throw new Error('Сначала создай аккаунт.');
  lastCrashReport = null;
  try { fs.unlinkSync(crashFile); } catch {}
  try {
  const p = cfg.profile;
  send('log', 'Подготовка…');
  const custom = p.loader !== 'vanilla' ? await ensureLoader(p.version, p.loader) : null;
  const authorization = await getAuth();
  const javaPath = await ensureJava(p.version);
  fs.mkdirSync(gameDir(), { recursive: true });
  setGameLang();
  const l = new Client();
  const runtimeLines = [];
  const remember = value => { runtimeLines.push(String(value)); if (runtimeLines.length > 500) runtimeLines.shift(); };
  let opened = false;
  let closeHandled = false;
  l.on('progress', e => send('progress', e));
  l.on('debug', m => { remember(m); send('log', String(m)); });
  l.on('data', m => {
    remember(m);
    send('log', String(m));
    if (opened) return;
    opened = true; gameRunning = true;
    if (cfg.closeOnLaunch) setTimeout(() => win && !win.isDestroyed() && win.close(), 3000);
  });
  l.on('close', async code => {
    if (closeHandled) return;
    closeHandled = true;
    gameRunning = false;
    if (code === 0) {
      if (win && !win.isDestroyed()) send('closed', code);
      else app.quit();
      return;
    }
    const report = createCrashReport(code, runtimeLines);
    publishCrash(report);
  });
  l.launch({
    authorization, root, ...(javaPath ? { javaPath } : {}), customArgs: javaArgs(),
    version: { number: p.version, type: 'release', ...(custom ? { custom } : {}) },
    memory: { max: cfg.ram + 'G', min: '1G' },
    overrides: { gameDirectory: gameDir() },
  }).catch(error => {
    if (closeHandled) return;
    closeHandled = true;
    gameRunning = false;
    const message = 'Ошибка запуска: ' + error.message;
    send('log', message);
    const report = createCrashReport('launch', runtimeLines, message);
    publishCrash(report);
  });
  } catch (error) {
    gameRunning = false;
    const message = 'Ошибка подготовки запуска: ' + error.message;
    send('log', message);
    const report = createCrashReport('launch', [], message);
    publishCrash(report);
    throw error;
  }
});

let gameRunning = false;
function createWindow() {
  rotateBackground();
  win = new BrowserWindow({
    width: 1100, height: 700, minWidth: 900, minHeight: 600,
    backgroundColor: '#1e1e1f', frame: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile('index.html');
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (!gameRunning) app.quit(); });
