/* 词迹 · 背单词 + 英文阅读（纯前端 PWA） */
(function () {
'use strict';

const DECKS = (window.WB_DECKS || []).slice();
const CLASSIC = (window.WB_CLASSIC || []).slice();
const DAY = 86400000;
const LS_KEY = 'ci_word_v1';

/* ---------------- 基础工具 ---------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dateStr = (d) => { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const today = () => dateStr();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wordKey = w => String(w || '').trim().toLowerCase();

function toast(msg, ms) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms || 2200);
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ---------------- 数据层 ---------------- */
function freshState() {
  return {
    v: 1,
    activeDeck: DECKS.length ? DECKS[0].id : 'primary',
    onboard: false,
    settings: { dailyNew: 20, artSize: 1, aiBase: '', aiKey: '', aiModel: '', ttsRate: 1, ttsVoice: '' },
    decks: {},        // id -> { srs, custom, day, newCount, history }
    articles: [],     // 用户导入 / 新闻文章
    reading: {},      // articleId -> { p, read, at }
  };
}

let DB = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && o.v === 1) return normalize(o);
    }
  } catch (e) { console.warn('读取本地数据失败', e); }
  return freshState();
}

function normalize(o) {
  const base = freshState();
  o.settings = Object.assign(base.settings, o.settings || {});
  o.decks = o.decks || {};
  o.articles = Array.isArray(o.articles) ? o.articles : [];
  o.reading = o.reading || {};
  o.onboard = !!o.onboard;
  if (!DECKS.some(d => d.id === o.activeDeck)) o.activeDeck = DECKS.length ? DECKS[0].id : 'primary';
  return o;
}

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); }
  catch (e) { toast('本地存储写入失败（可能空间不足），请先导出备份'); }
}

function deckState(id) {
  if (!DB.decks[id]) DB.decks[id] = { srs: {}, custom: [], day: '', newCount: 0, history: {} };
  const st = DB.decks[id];
  st.srs = st.srs || {};
  st.custom = st.custom || [];
  st.history = st.history || {};
  if (st.day !== today()) { st.day = today(); st.newCount = 0; }
  return st;
}

const deckCache = new Map();
function deckData(id) {
  if (deckCache.has(id)) return deckCache.get(id);
  const meta = DECKS.find(d => d.id === id) || DECKS[0] || { id: id, name: id, words: [] };
  const st = (DB.decks[id] && DB.decks[id].custom) || [];
  const words = [], map = new Map();
  const add = a => {
    const k = wordKey(a[0]);
    if (!k || map.has(k)) return;
    const w = { w: a[0], p: a[1] || '', m: a[2] || '', e: a[3] || '', k: k, deck: id };
    map.set(k, w); words.push(w);
  };
  st.forEach(add);
  (meta.words || []).forEach(add);
  const out = { meta: meta, words: words, map: map };
  deckCache.set(id, out);
  return out;
}

function allDecks() { return DECKS; }

/* 词库总词量 = 内置 + 自己导入/加入的补词（补词时已去重） */
function deckTotal(id) {
  const meta = DECKS.find(d => d.id === id);
  const st = DB.decks[id];
  return (meta ? meta.words.length : 0) + ((st && st.custom) ? st.custom.length : 0);
}

/* 全局查词表（阅读点词用） */
let DICT = null;
function dictionary() {
  if (DICT) return DICT;
  DICT = new Map();
  DECKS.forEach(d => {
    (d.words || []).forEach(a => {
      const k = wordKey(a[0]);
      if (k && !DICT.has(k)) DICT.set(k, { w: a[0], p: a[1] || '', m: a[2] || '', deck: d.id });
    });
  });
  return DICT;
}

/* ---------------- 视图路由 ---------------- */
const state = { page: 'study', readTab: 'classic', readerId: null };
let session = { deck: null, queue: [], revealed: false, lastNew: null };

function setPage(p) {
  state.page = p;
  $$('.page').forEach(el => { el.hidden = el.id !== 'page-' + p; });
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.page === p));
  const titles = { study: '今天', reading: '阅读', stats: '统计', settings: '设置' };
  $('#pageTitle').textContent = titles[p] || '今天';
  $('#pageSub').textContent = p === 'study' ? (deckData(DB.activeDeck).meta.name + ' · 按遗忘曲线复习')
    : p === 'reading' ? '外刊与经典，点词即查' : p === 'stats' ? '你的学习节奏' : '词库 / 备份 / 朗读';
  $('#topbar').style.display = p === 'study' || p === 'settings' ? '' : 'none';
  if (p === 'study') renderStudy();
  if (p === 'reading') renderReading();
  if (p === 'stats') renderStats();
  if (p === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
}

function closeReader() {
  stopTTS();
  if (progressObs) { progressObs.disconnect(); progressObs = null; }
  $('#reader').hidden = true;
  document.body.classList.remove('reading-open');
  $$('.page').forEach(el => { el.hidden = el.id !== 'page-' + state.page; });
  state.readerId = null;
  if (state.page === 'reading') renderReading();
}

function openReader(id) {
  const art = getArticle(id);
  if (!art) return;
  state.readerId = id;
  $$('.page').forEach(el => { el.hidden = true; });
  $('#reader').hidden = false;
  document.body.classList.add('reading-open');
  renderReader(art);
  const rp = DB.reading[id] || {};
  DB.reading[id] = { p: rp.p || 0, read: !!rp.read, at: Date.now() };
  save();
  window.scrollTo({ top: 0 });
}

/* ---------------- 学习：队列 / SM-2 ---------------- */
function buildQueue(id) {
  const st = deckState(id);
  const dd = deckData(id);
  const now = Date.now();
  const due = [], fresh = [];
  dd.words.forEach(w => {
    const s = st.srs[w.k];
    if (!s) fresh.push(w.k);
    else if ((s.d || 0) <= now) due.push({ k: w.k, d: s.d || 0 });
  });
  due.sort((a, b) => a.d - b.d);
  const allow = Math.max(0, (DB.settings.dailyNew || 0) - (st.newCount || 0));
  return due.map(x => x.k).concat(fresh.slice(0, allow));
}

function ensureSession() {
  if (session.deck !== DB.activeDeck) {
    session = { deck: DB.activeDeck, queue: buildQueue(DB.activeDeck), revealed: false };
  }
  if (!session.queue) session.queue = buildQueue(DB.activeDeck);
}

function currentWord() {
  const k = session.queue[0];
  return k ? deckData(DB.activeDeck).map.get(k) : null;
}

function hintFor(q, srs) {
  if (q === 1) return '约 10 分钟后再次出现';
  if (q === 3) return '明天复习';
  const reps = (srs && srs.r) || 0;
  let i;
  if (reps === 0) i = 1;
  else if (reps === 1) i = 3;
  else i = Math.max(1, Math.round(((srs && srs.i) || 1) * ((srs && srs.e) || 2.5)));
  if (q === 6) i = Math.max(i + 2, Math.round(i * 1.3));
  return i >= 30 ? ('约 ' + Math.round(i / 30) + ' 个月后') : ('约 ' + i + ' 天后');
}

function rate(q) {
  ensureSession();
  const id = DB.activeDeck;
  const k = session.queue.shift();
  if (!k) return;
  const st = deckState(id);
  const s = st.srs[k];
  const isNew = !s;
  const now = Date.now();
  const item = s || { e: 2.5, i: 0, r: 0, l: 0, d: 0, s: 'learn' };
  if (q < 3) {
    item.l = (item.l || 0) + 1;
    item.r = 0;
    item.i = 0;
    item.d = now + 10 * 60 * 1000;
    item.s = 'learn';
  } else {
    item.r = (item.r || 0) + 1;
    let iv;
    if (item.r === 1) iv = 1;
    else if (item.r === 2) iv = 3;
    else iv = Math.max(1, Math.round((item.i || 1) * (item.e || 2.5)));
    if (q === 5) item.e = clamp((item.e || 2.5) + 0.1, 1.3, 3.0);
    if (q === 3) item.e = clamp((item.e || 2.5) - 0.14, 1.3, 3.0);
    if (q === 6) { item.e = clamp((item.e || 2.5) + 0.15, 1.3, 3.0); iv = Math.max(iv + 2, Math.round(iv * 1.3)); }
    item.i = iv;
    item.d = now + iv * DAY;
    item.s = iv >= 21 ? 'master' : 'review';
  }
  item.last = now;
  st.srs[k] = item;

  const h = st.history[today()] || { r: 0, n: 0 };
  h.r++;
  if (isNew) { h.n++; st.newCount = (st.newCount || 0) + 1; }
  st.history[today()] = h;

  // 不认识的词稍后在本轮再出现
  if (q < 3) {
    const pos = Math.min(3, session.queue.length);
    session.queue.splice(pos, 0, k);
  }
  session.revealed = false;
  save();
  renderStudy();
  if (q < 3) toast('10 分钟后会再见它');
}

function renderStudy() {
  ensureSession();
  const id = DB.activeDeck;
  const st = deckState(id);
  const meta = deckData(id).meta;
  $('#deckChipName').textContent = meta.name;
  const done = (st.history[today()] || {}).r || 0;
  const left = session.queue.length;
  const total = done + left;
  $('#mDone').textContent = done;
  $('#mLeft').textContent = left;
  $('#mStreak').textContent = streakDays();
  $('#todayBar').style.width = (total ? Math.round(done / total * 100) : 100) + '%';
  $('#progressText').textContent = '今日进度 ' + (total ? Math.round(done / total * 100) : 100) + '%';
  $('#progressRemain').textContent = left ? ('还剩 ' + left + ' 个') : '已完成';

  const area = $('#cardArea');
  const w = currentWord();
  if (!w) {
    area.innerHTML = '<div class="done-card"><div class="done-emoji">🎉</div><h2>今天的任务完成啦</h2>' +
      '<p>复习逻辑会自动安排后面几天的词。明天再来，或者现在去读一篇。</p>' +
      '<div class="row" style="justify-content:center;gap:8px">' +
      '<button class="btn" data-act="restart-day">再多学几个新词</button>' +
      '<button class="btn primary" data-act="go-reading">去阅读</div></div>';
    return;
  }
  const srs = st.srs[w.k];
  const hint1 = hintFor(1, srs), hint3 = hintFor(3, srs), hint5 = hintFor(5, srs), hint6 = hintFor(6, srs);
  area.innerHTML =
    '<div class="word-card">' +
      '<div class="word-row"><h1 class="word">' + esc(w.w) + '</h1>' +
        '<button class="speak" data-act="speak-word" aria-label="发音">🔊</button></div>' +
      '<div class="phonetic">' + (session.revealed ? esc(w.p) : '&nbsp;') + '</div>' +
      (session.revealed ?
        '<div class="answer">' +
          '<p class="meaning">' + esc(w.m) + '</p>' +
          (w.e ? '<div class="example">' + esc(w.e) + '</div>' : '') +
          '<div class="rate-grid">' +
            '<button class="rate r1" data-act="rate" data-q="1">不认识<small>' + hint1 + '</small></button>' +
            '<button class="rate r2" data-act="rate" data-q="3">模糊<small>' + hint3 + '</small></button>' +
            '<button class="rate r3" data-act="rate" data-q="5">认识<small>' + hint5 + '</small></button>' +
            '<button class="rate r4" data-act="rate" data-q="6">太简单<small>' + hint6 + '</small></button>' +
          '</div>' +
        '</div>'
        : '<div class="gate"><p>先在心里想一下它的意思</p><button class="btn primary big block" data-act="reveal">显示答案</button></div>'
      ) +
    '</div>';
}

/* ---------------- 统计 ---------------- */
function historyDates() {
  const set = new Set();
  Object.keys(DB.decks).forEach(id => {
    const h = (DB.decks[id] && DB.decks[id].history) || {};
    Object.keys(h).forEach(d => { if ((h[d] || {}).r > 0) set.add(d); });
  });
  return set;
}
function streakDays() {
  const dates = historyDates();
  if (!dates.size) return 0;
  let n = 0;
  const d = new Date();
  // 允许今天还没学但昨天学过仍显示连续
  if (!dates.has(dateStr(d))) d.setTime(d.getTime() - DAY);
  for (let i = 0; i < 4000; i++) {
    if (!dates.has(dateStr(d))) break;
    n++; d.setTime(d.getTime() - DAY);
  }
  return n;
}

function renderStats() {
  const id = DB.activeDeck;
  const dd = deckData(id);
  const st = deckState(id);
  const total = dd.words.length;
  const learnedKeys = Object.keys(st.srs);
  let master = 0, learning = 0;
  learnedKeys.forEach(k => {
    const s = st.srs[k];
    if ((s.i || 0) >= 21) master++;
    else learning++;
  });
  const fresh = Math.max(0, total - learnedKeys.length);
  const pct = (n) => total ? (n / total * 100) : 0;
  const todayDone = (st.history[today()] || {}).r || 0;
  const week = [];
  const base = new Date(); base.setHours(0, 0, 0, 0);
  for (let i = 0; i < 7; i++) {
    const from = base.getTime() + i * DAY, to = from + DAY;
    let c = 0;
    learnedKeys.forEach(k => {
      const s = st.srs[k];
      if (i === 0 ? (s.d < to) : (s.d >= from && s.d < to)) c++;
    });
    week.push(c);
  }
  const maxWeek = Math.max(1, ...week);
  const labels = ['今天', '明天', '后天', '第4天', '第5天', '第6天', '第7天'];
  $('#statsBody').innerHTML =
    '<div class="stat-hero">' +
      '<div class="big">' + streakDays() + ' 天</div><div class="cap">连续打卡（任意词库）</div>' +
      '<div class="hero-grid">' +
        '<div><b>' + todayDone + '</b><span>今日复习次数</span></div>' +
        '<div><b>' + learnedKeys.length + '</b><span>本词库已学</span></div>' +
        '<div><b>' + Math.round((total ? learnedKeys.length / total * 100 : 0)) + '%</b><span>覆盖进度</span></div>' +
      '</div>' +
    '</div>' +
    '<div class="panel"><h2>掌握程度分布 · ' + esc(dd.meta.name) + '</h2>' +
      '<div class="stack-bar">' +
        '<i style="width:' + pct(fresh) + '%;background:#94a3b8"></i>' +
        '<i style="width:' + pct(learning) + '%;background:#f59e0b"></i>' +
        '<i style="width:' + pct(master) + '%;background:#22c55e"></i>' +
      '</div>' +
      '<div class="legend">' +
        '<span><i class="dot" style="background:#94a3b8"></i>新词 ' + fresh + '</span>' +
        '<span><i class="dot" style="background:#f59e0b"></i>学习中 ' + learning + '</span>' +
        '<span><i class="dot" style="background:#22c55e"></i>已掌握 ' + master + '</span>' +
      '</div>' +
      '<p class="note" style="margin-top:10px">已掌握 = 复习间隔达到 21 天以上；分布随自评结果自动变化。</p>' +
    '</div>' +
    '<div class="panel"><h2>未来 7 天复习量预估</h2>' +
      '<div class="forecast">' + week.map((c, i) =>
        '<div class="fc"><div class="bar-wrap"><div class="bar" style="height:' + Math.max(2, c / maxWeek * 100) + '%"></div></div><b>' + c + '</b>' + labels[i] + '</div>'
      ).join('') + '</div>' +
      '<p class="note" style="margin-top:8px">按当前间隔推算；逾期未复习的词会累加到“今天”。</p>' +
    '</div>' +
    '<div class="panel"><h2>词库一览</h2>' + DECKS.map(d => {
      const dst = deckState(d.id);
      const n = Object.keys(dst.srs).length;
      const dt = deckTotal(d.id);
      return '<div class="deck-row"><div class="grow"><h3>' + esc(d.name) + '</h3>' +
        '<div class="sub">' + dt + ' 词 · 已学 ' + n + '</div></div>' +
        '<span class="badge grey">' + (dt ? Math.round(n / dt * 100) : 0) + '%</span></div>';
    }).join('') + '</div>';
}

/* ---------------- 设置 ---------------- */
function renderSettings() {
  const st = deckState(DB.activeDeck);
  const body = $('#settingsBody');
  body.innerHTML =
    '<div class="sec-title"><span>我的词库</span><span class="badge grey">进度相互独立</span></div>' +
    '<div class="panel" style="padding:4px 14px">' +
      DECKS.map(d => {
        const dst = deckState(d.id);
        const n = Object.keys(dst.srs).length;
        const dt = deckTotal(d.id);
        const pct = dt ? Math.round(n / dt * 100) : 0;
        const active = d.id === DB.activeDeck;
        return '<div class="deck-row" data-act="switch-deck" data-deck="' + d.id + '" role="button">' +
          '<div class="grow"><h3>' + esc(d.name) + (active ? ' <span class="check">✓</span>' : '') + '</h3>' +
          '<div class="sub">' + dt + ' 词 · 已学 ' + n + '（' + pct + '%）</div>' +
          '<div class="mini-progress"><i style="width:' + pct + '%"></i></div></div>' +
          (active ? '<span class="badge">当前</span>' : '<span class="badge grey">切换</span>') +
        '</div>';
      }).join('') +
    '</div>' +
    '<p class="note">每个词库的复习记录、每日任务、统计都分开保存，切换不会清空其它进度。</p>' +

    '<div class="sec-title"><span>学习设置</span></div>' +
    '<div class="panel">' +
      '<div class="setting-row"><div><div class="label">每日新词上限</div><div class="sub">默认 20，复习量不受此限</div></div>' +
        '<div class="stepper"><button data-act="new-minus">−</button><span id="newLimit">' + DB.settings.dailyNew + '</span><button data-act="new-plus">+</button></div></div>' +
      '<div class="setting-row"><div><div class="label">发音</div><div class="sub">使用浏览器自带 TTS（en-US）</div></div>' +
        '<button class="btn" data-act="test-voice">试听</button></div>' +
    '</div>' +

    '<div class="sec-title"><span>补词 / 备份</span></div>' +
    '<div class="panel">' +
      '<button class="btn block" data-act="import-csv">导入 CSV 补词到「' + esc(deckData(DB.activeDeck).meta.name) + '」</button>' +
      '<p class="note" style="margin:8px 0 14px">支持逗号或 Tab 分隔，列顺序：单词, 音标, 释义, 例句（音标/例句可留空）。</p>' +
      '<button class="export-btn" data-act="export-json">导出备份 JSON</button>' +
      '<button class="btn block" data-act="import-json">从 JSON 恢复</button>' +
      '<p class="note" style="margin-top:10px">备份包含：所有词库进度、自己导入的词、文章库、阅读进度与设置。清缓存或换手机前请先导出。</p>' +
    '</div>' +

    '<div class="sec-title"><span>AI 翻译（可选）</span></div>' +
    '<div class="panel">' +
      '<p class="note" style="margin-top:0">不配置也能正常阅读：可只读英文、或导入时粘贴自己的中文译文。配置后可按段自动翻译并缓存。支持 OpenAI 兼容接口。</p>' +
      '<div class="field"><label>接口地址（Base URL）</label><input class="input" id="aiBase" placeholder="https://api.openai.com/v1" value="' + esc(DB.settings.aiBase) + '"></div>' +
      '<div class="field"><label>模型名</label><input class="input" id="aiModel" placeholder="gpt-4o-mini" value="' + esc(DB.settings.aiModel) + '"></div>' +
      '<div class="field"><label>API Key（仅存本机）</label><input class="input" id="aiKey" type="password" placeholder="sk-..." value="' + esc(DB.settings.aiKey) + '"></div>' +
      '<button class="btn primary block" data-act="save-ai">保存翻译设置</button>' +
    '</div>' +

    '<div class="sec-title"><span>关于</span></div>' +
    '<div class="panel"><p class="note" style="margin:0">' +
      '词库数据：ECDICT 开源词典（MIT，github.com/skywind3000/ECDICT）；小学词库释义与例句为原创。经典文章为公有领域作品原文（Project Gutenberg），中文译文为本项目自译。' +
      '<br>所有数据只存在这台设备的浏览器里，不上传、不联网同步。' +
      '</p></div>';
  void st;
}

/* ---------------- 阅读 ---------------- */
const RSS_SOURCES = [
  { id: 'npr', name: 'NPR · World', url: 'https://feeds.npr.org/1004/rss.xml', ok: true },
  { id: 'npr1001', name: 'NPR · Top Stories', url: 'https://feeds.npr.org/1001/rss.xml', ok: true },
];
const newsCache = {}; // sourceId -> items
let customRssUrl = '';

function allArticles() {
  return CLASSIC.map(a => Object.assign({ tab: 'classic' }, a)).concat(DB.articles);
}
function getArticle(id) {
  const c = CLASSIC.find(a => a.id === id);
  if (c) return Object.assign({ tab: 'classic' }, c);
  const u = DB.articles.find(a => a.id === id);
  return u ? Object.assign({ tab: u.tab || 'news' }, u) : null;
}

const STOP = new Set(('a an the and or but if of to in on at by for from with as is are was were be been being it its this that these those he she they them his her their we you i my your our not no so do does did have has had can could will would should may might must there here then than too very just about into over after before when while what which who whom whose how why all any some such only own same both each other more most').split(' '));

const SUFFIX = [
  ['ies', 'y'], ['ied', 'y'], ['ing', ''], ['ing', 'e'], ['ed', ''], ['ed', 'e'], ['es', ''], ['s', ''], ['ly', ''], ['er', ''], ['est', ''], ['ness', ''], ['ment', '']
];

function mapLookup(map, k) {
  if (map.has(k)) return map.get(k);
  for (const [suf, rep] of SUFFIX) {
    if (k.length > suf.length + 2 && k.endsWith(suf)) {
      const base = k.slice(0, -suf.length) + rep;
      if (map.has(base)) return map.get(base);
      if (suf === 'ing' || suf === 'ed') {
        const dbl = k.slice(0, -suf.length);
        if (dbl.length > 2 && dbl[dbl.length - 1] === dbl[dbl.length - 2] && map.has(dbl.slice(0, -1))) return map.get(dbl.slice(0, -1));
      }
    }
  }
  return null;
}

/* 点词查义：优先当前学习阶段的词库，其次全局内置词表 */
function lookupWord(raw, preferDeck) {
  const k = wordKey(raw);
  if (preferDeck) {
    const hit = mapLookup(deckData(preferDeck).map, k);
    if (hit) return hit;
  }
  return mapLookup(dictionary(), k);
}

const LEVELS = DECKS.map(d => d.id);
const levelSets = {};
function levelSet(i) {
  const key = LEVELS.slice(0, i + 1).join('|');
  if (levelSets[key]) return levelSets[key];
  const set = new Set();
  LEVELS.slice(0, i + 1).forEach(id => {
    (DECKS.find(d => d.id === id) || { words: [] }).words.forEach(a => set.add(wordKey(a[0])));
  });
  levelSets[key] = set;
  return set;
}

function wordInSet(w, set) {
  if (set.has(w)) return true;
  for (const [suf, rep] of SUFFIX) {
    if (w.length > suf.length + 2 && w.endsWith(suf)) {
      const base = w.slice(0, -suf.length) + rep;
      if (set.has(base)) return true;
    }
  }
  return false;
}

const diffCache = new Map();
/* 难度：按“累计词表覆盖率”估算。取覆盖率首次达到 80% 的那一档；
   80% 表示该档学习者平均认识文中 80% 的实词，剩下约 20% 是生词。 */
const DIFF_TARGET = 0.80;
function analyze(art) {
  const ck = String(art.id || art.title);
  if (diffCache.has(ck)) return diffCache.get(ck);
  const text = art.paragraphs.map(p => p.en).join(' ');
  const tokens = (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).map(t => t.toLowerCase());
  const meaningful = tokens.filter(t => !STOP.has(t));
  const total = meaningful.length || 1;
  let best = LEVELS.length - 1, ratio = 1;
  for (let i = 0; i < LEVELS.length; i++) {
    const set = levelSet(i);
    let ok = 0;
    meaningful.forEach(t => { if (wordInSet(t, set)) ok++; });
    const cov = ok / total;
    if (cov >= DIFF_TARGET) { best = i; ratio = cov; break; }
    if (i === LEVELS.length - 1) { best = LEVELS.length; ratio = cov; }
  }
  const topSet = levelSet(Math.min(best, LEVELS.length - 1));
  const uniqUnknown = new Set();
  meaningful.forEach(t => { if (!wordInSet(t, topSet)) uniqUnknown.add(t); });
  const res = {
    level: best,
    label: best >= LEVELS.length ? '超纲' : deckData(LEVELS[best]).meta.name,
    deckId: best >= LEVELS.length ? LEVELS[LEVELS.length - 1] : LEVELS[best],
    words: (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length,
    newRatio: Math.max(0, 1 - ratio),
    unknown: uniqUnknown.size,
    tokens: total
  };
  diffCache.set(ck, res);
  return res;
}

function levelBadge(diff) {
  return '<span class="' + (diff.level >= LEVELS.length ? 'badge warn' : 'badge') + '">' + esc(diff.label) + '</span>';
}

function renderReading() {
  $$('#readTabs .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === state.readTab));
  const body = $('#readBody');
  if (state.readTab === 'classic') {
    body.innerHTML = '<p class="note" style="margin-top:0">公有领域经典选段（原文来自 Project Gutenberg，译文为本项目自译）。难度按当前词库覆盖率自动估算。</p>' +
      '<div class="list">' + CLASSIC.map(a => {
        const d = analyze(a);
        const r = DB.reading[a.id] || {};
        const progress = r.read ? '已读完' : (r.p ? ('读到第 ' + (r.p + 1) + ' 段') : '未读');
        return '<button class="item" data-act="open" data-id="' + a.id + '">' +
          '<div class="row between"><h3>' + esc(a.title) + '</h3>' + levelBadge(d) + '</div>' +
          '<div class="meta"><span>' + esc(a.author) + '</span><span>· ' + (a.year || '') + '</span>' +
          '<span>· ' + d.words + ' 词</span><span>· 生词约 ' + Math.round(d.newRatio * 100) + '%</span></div>' +
          '<div class="sub">' + esc(progress) + '</div></button>';
      }).join('') + '</div>';
  } else if (state.readTab === 'news') {
    body.innerHTML =
      '<p class="note" style="margin-top:0">本机实测：NPR 的 RSS 可直连；BBC / Guardian / Al Jazeera 在当前网络下不可达，因此未内置（不假装能用）。你也可以粘贴任意 RSS 地址。</p>' +
      '<div class="list">' + RSS_SOURCES.map(s => {
        const got = newsCache[s.id];
        return '<div class="item"><div class="row between"><h3>' + esc(s.name) + ' <span class="badge green">可直连</span></h3>' +
          '<button class="btn" data-act="rss-load" data-src="' + s.id + '">拉取</button></div>' +
          '<div class="sub" id="src-' + s.id + '">' + (got ? '已获取 ' + got.length + ' 条' : '尚未拉取') + '</div>' +
          renderNewsItems(s.id) + '</div>';
      }).join('') + '</div>' +
      '<div class="panel"><h2>自定义 RSS</h2>' +
      '<div class="field"><label>RSS 地址</label><input class="input" id="customRss" placeholder="https://example.com/feed.xml" value="' + esc(customRssUrl) + '"></div>' +
      '<div class="row"><button class="btn primary" data-act="rss-custom">拉取这个源</button></div>' +
      '<div class="sub" id="src-custom">' + (newsCache.custom ? '已获取 ' + newsCache.custom.length + ' 条' : '尚未拉取') + '</div>' +
      renderNewsItems('custom') +
      '<p class="note" style="margin-bottom:0">抓取通过本站服务端转发；失败时请用下面「粘贴正文」手动导入。</p></div>' +
      '<div class="panel"><h2>粘贴链接 / 粘贴正文</h2>' +
      '<div class="field"><label>文章链接</label><input class="input" id="pasteUrl" placeholder="https://..."></div>' +
      '<button class="btn block" data-act="extract-url">尝试提取正文</button>' +
      '<p class="note" style="margin-bottom:0">提取失败会立即弹出粘贴框，不会一直转圈。</p></div>';
  } else {
    const mine = DB.articles;
    body.innerHTML = '<div class="row" style="gap:8px;margin-bottom:12px">' +
      '<button class="btn primary" style="flex:1" data-act="import-article">导入文章</button></div>' +
      (mine.length ? '<div class="list">' + mine.map(a => {
        const d = analyze(a);
        const r = DB.reading[a.id] || {};
        const progress = r.read ? '已读完' : (r.p ? ('读到第 ' + (r.p + 1) + ' 段') : '未读');
        return '<div class="item"><div class="row between"><h3 data-act="open" data-id="' + a.id + '" style="flex:1">' + esc(a.title) + '</h3>' + levelBadge(d) + '</div>' +
          '<div class="meta"><span>' + esc(a.sourceName || '手动导入') + '</span><span>· ' + d.words + ' 词</span><span>· 生词约 ' + Math.round(d.newRatio * 100) + '%</span></div>' +
          '<div class="row between"><div class="sub">' + esc(progress) + '</div>' +
          '<button class="linkish" data-act="del-article" data-id="' + a.id + '">删除</button></div></div>';
      }).join('') + '</div>' : '<div class="empty">还没有自己的文章。点上面的按钮粘贴一篇。</div>');
  }
}

function renderNewsItems(srcId) {
  const items = newsCache[srcId];
  if (!items) return '';
  if (!items.length) return '<div class="sub">这个源暂时没有条目</div>';
  return '<div style="margin-top:8px">' + items.slice(0, 8).map((it, i) =>
    '<div class="row between" style="padding:6px 0;border-top:1px solid var(--line)">' +
      '<button class="linkish" style="text-align:left;flex:1;font-size:13px;color:var(--text)" data-act="open-news" data-src="' + srcId + '" data-i="' + i + '">' + esc(it.title) + '</button>' +
      '<span class="badge grey">打开</span></div>'
  ).join('') + '</div>';
}

/* RSS 抓取（优先同源服务端转发，其次直连） */
async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const r = await fetch('/api/fetch?url=' + encodeURIComponent(url), { signal: ctrl.signal });
    if (r.ok) { clearTimeout(t); return await r.text(); }
    throw new Error('proxy ' + r.status);
  } catch (e) {
    clearTimeout(t);
  }
  const ctrl2 = new AbortController();
  const t2 = setTimeout(() => ctrl2.abort(), timeoutMs || 20000);
  try {
    const r = await fetch(url, { signal: ctrl2.signal, mode: 'cors' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t2); }
}

function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('RSS 解析失败');
  let nodes = Array.from(doc.querySelectorAll('item'));
  if (!nodes.length) nodes = Array.from(doc.querySelectorAll('entry'));
  return nodes.slice(0, 10).map(n => {
    const title = (n.querySelector('title') || {}).textContent || '';
    let link = (n.querySelector('link') || {}).textContent || '';
    if (!link) { const l = n.querySelector('link[href]'); if (l) link = l.getAttribute('href'); }
    const date = (n.querySelector('pubDate') || n.querySelector('updated') || {}).textContent || '';
    return { title: title.trim(), link: link.trim(), date: date.trim() };
  }).filter(x => x.title && x.link);
}

async function loadRss(srcId, customUrl) {
  const src = customUrl ? { id: 'custom', name: '自定义', url: customUrl } : RSS_SOURCES.find(s => s.id === srcId);
  if (!src) return;
  if (customUrl) customRssUrl = customUrl;
  const slot = $('#src-' + src.id);
  if (slot) slot.innerHTML = '<span class="spin"></span> 正在拉取…';
  try {
    const xml = await fetchText(src.url, 20000);
    const items = parseFeed(xml);
    if (!items.length) throw new Error('这个源没有可读条目');
    newsCache[src.id] = items;
    renderReading();
    toast('已拉取 ' + items.length + ' 条');
  } catch (e) {
    if ($('#src-' + src.id)) $('#src-' + src.id).textContent = '拉取失败：' + e.message;
    toast('拉取失败：可改用粘贴正文导入');
  }
}

async function openNews(srcId, i) {
  const item = (newsCache[srcId] || [])[i];
  if (!item) return;
  toast('正在提取正文…');
  try {
    const html = await fetchText(item.link, 25000);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,nav,footer,header,aside,form').forEach(n => n.remove());
    let ps = Array.from(doc.querySelectorAll('article p, main p, [class*="article"] p, [class*="story"] p'))
      .map(p => p.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 40);
    if (ps.length < 2) ps = Array.from(doc.querySelectorAll('p')).map(p => p.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 60);
    if (ps.length < 2) throw new Error('没能提取到正文');
    const art = {
      id: 'u' + Date.now(),
      tab: 'news',
      title: item.title,
      sourceName: srcId === 'custom' ? '自定义 RSS' : (RSS_SOURCES.find(s => s.id === srcId) || {}).name,
      sourceUrl: item.link,
      paragraphs: ps.slice(0, 40).map(en => ({ en: en, zh: '' })),
      createdAt: Date.now()
    };
    DB.articles.unshift(art); save();
    openReader(art.id);
  } catch (e) {
    openImportModal({ url: item.link, title: item.title, sourceName: '新闻（手动粘贴正文）', error: e.message });
  }
}

async function extractFromUrl(url, targetTextarea, titleInput) {
  toast('正在提取…');
  try {
    const html = await fetchText(url, 25000);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,nav,footer,header,aside,form').forEach(n => n.remove());
    let ps = Array.from(doc.querySelectorAll('article p, main p, [class*="article"] p, [class*="story"] p'))
      .map(p => p.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 40);
    if (ps.length < 2) ps = Array.from(doc.querySelectorAll('p')).map(p => p.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 60);
    if (ps.length < 2) throw new Error('没能提取到正文');
    targetTextarea.value = ps.slice(0, 60).join('\n\n');
    if (titleInput && !titleInput.value) titleInput.value = (doc.querySelector('title') || {}).textContent.trim();
    toast('提取成功，可在下方编辑');
  } catch (e) {
    toast('提取失败：' + e.message + '。请直接粘贴正文');
  }
}

function openImportModal(opts) {
  opts = opts || {};
  openModal('<h2>导入文章</h2>' +
    '<p class="note" style="margin-top:0">自己粘贴正文最稳；链接提取可能被网站限制。</p>' +
    (opts.error ? '<p class="note" style="color:var(--bad)">自动提取失败：' + esc(opts.error) + '，请把正文粘贴进来。</p>' : '') +
    '<div class="field"><label>标题</label><input class="input" id="imTitle" value="' + esc(opts.title || '') + '" placeholder="文章标题"></div>' +
    '<div class="field"><label>原文链接（可选）</label><input class="input" id="imUrl" value="' + esc(opts.url || '') + '"></div>' +
    '<div class="field"><label>英文正文</label><textarea class="input" id="imText" placeholder="把英文正文粘贴到这里…" style="min-height:150px"></textarea></div>' +
    '<div class="field"><label>中文译文（可选，段落之间空一行；不填也可以先只读英文）</label><textarea class="input" id="imZh" placeholder="粘贴自己的译文，或留空"></textarea></div>' +
    '<div class="row"><button class="btn" data-act="extract-modal">从链接尝试提取</button></div>' +
    '<div class="modal-actions"><button class="btn" data-act="close-modal">取消</button><button class="btn primary" data-act="save-article">保存并打开</button></div>');
}

function saveArticleFromModal() {
  const title = ($('#imTitle').value || '').trim() || '未命名文章';
  const url = ($('#imUrl').value || '').trim();
  const text = ($('#imText').value || '').trim();
  if (!text) return toast('请先粘贴英文正文');
  const zh = ($('#imZh').value || '');
  const paras = text.split(/\n\s*\n/).map(t => t.trim()).filter(Boolean);
  if (!paras.length) return toast('正文为空');
  const zhParas = zh.trim() ? zh.split(/\n\s*\n/).map(t => t.trim()) : [];
  const art = {
    id: 'u' + Date.now(),
    tab: 'mine',
    title: title,
    sourceName: url ? '网页导入' : '手动导入',
    sourceUrl: url,
    paragraphs: paras.map((en, i) => ({ en: en, zh: zhParas[i] || '' })),
    createdAt: Date.now()
  };
  DB.articles.unshift(art); save(); closeModal();
  openReader(art.id);
  if (zhParas.length && zhParas.length !== paras.length) toast('译文段落数与正文不一致，已按顺序对齐');
}

/* ---------------- 阅读器 ---------------- */
let sentMap = [];
let tts = { playing: false, paused: false, idx: 0, rate: 1, voiceName: '', articleId: null };
let voices = [];

function renderReader(art) {
  const diff = analyze(art);
  $('#readerTitle').textContent = art.title;
  $('#readerMeta').innerHTML = esc([art.author, art.year, art.sourceName].filter(Boolean).join(' · ')) +
    (art.sourceUrl ? ' <a href="' + esc(art.sourceUrl) + '" target="_blank" rel="noopener">原文链接</a>' : '') +
    '<br>' + diff.words + ' 词 · 生词约 ' + Math.round(diff.newRatio * 100) + '% · 仅供个人学习阅读';
  $('#readerLevelBadge').textContent = '难度 ' + diff.label;
  $('#readerFontBtn').textContent = ['A−', 'A', 'A+'][DB.settings.artSize] || 'A';
  applyArtSize();

  sentMap = [];
  const hasZh = art.paragraphs.some(p => p.zh);
  $('#toggleAllZh').textContent = '整篇译文：关';
  $('#toggleAllZh').dataset.on = '0';
  $('#articleBody').innerHTML = art.paragraphs.map((p, pi) => {
    const sents = splitSentences(p.en);
    const sentHtml = sents.map(s => {
      const gi = sentMap.length;
      sentMap.push({ text: s, p: pi });
      return '<span class="sent" data-sent="' + gi + '">' + tokenizeHtml(s) + '</span>';
    }).join(' ');
    return '<div class="para" data-p="' + pi + '">' +
      '<p class="en">' + sentHtml + '</p>' +
      (p.zh ? '<button class="zh-toggle" data-act="zh" data-p="' + pi + '">显示中文</button><div class="zh-text hidden" data-zh="' + pi + '">' + esc(p.zh) + '</div>'
            : '<button class="zh-toggle" data-act="translate-para" data-p="' + pi + '">翻译本段</button>') +
      '</div>';
  }).join('');
  if (!hasZh) $('#toggleAllZh').textContent = '整篇译文：无译文';

  // 阅读位置
  const rp = DB.reading[art.id] || {};
  if (rp.p) {
    const el = $('.para[data-p="' + rp.p + '"]');
    if (el) setTimeout(() => el.scrollIntoView({ block: 'start' }), 60);
  }
  observeProgress(art);
}

function splitSentences(text) {
  const m = text.match(/[^.!?]+[.!?]+["'”’)]*|[^.!?]+$/g);
  return (m || [text]).map(s => s.trim()).filter(Boolean);
}

function tokenizeHtml(s) {
  const fmt = t => esc(t).replace(/\n/g, '<br>');
  let out = '', last = 0;
  const re = /[A-Za-z][A-Za-z'’-]*/g;
  let m;
  while ((m = re.exec(s))) {
    out += fmt(s.slice(last, m.index));
    out += '<span class="w" data-w="' + esc(m[0]) + '">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
  }
  out += fmt(s.slice(last));
  return out;
}

function applyArtSize() {
  const sizes = ['15px', '17px', '19px'];
  $('#articleBody').style.setProperty('--art-size', sizes[DB.settings.artSize] || '17px');
}

let progressObs = null;
function observeProgress(art) {
  if (progressObs) progressObs.disconnect();
  const last = art.paragraphs.length - 1;
  progressObs = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const pi = Number(en.target.dataset.p);
      const rp = DB.reading[art.id] || { p: 0, read: false };
      rp.p = Math.max(rp.p || 0, Math.min(pi + 1, last));
      rp.read = rp.read || (pi === last);
      rp.at = Date.now();
      DB.reading[art.id] = rp;
      save();
    });
  }, { threshold: 0.4 });
  $$('.para').forEach(p => progressObs.observe(p));
}

function toggleParagraphZh(pi, show) {
  const btn = $('.zh-toggle[data-p="' + pi + '"]');
  const text = $('[data-zh="' + pi + '"]');
  if (!text) return toast('这一段还没有译文');
  const willShow = show === undefined ? text.classList.contains('hidden') : show;
  text.classList.toggle('hidden', !willShow);
  if (btn) btn.textContent = willShow ? '收起中文' : '显示中文';
}

function toggleAllZh() {
  const btn = $('#toggleAllZh');
  const on = btn.dataset.on === '1';
  $$('[data-zh]').forEach(el => el.classList.toggle('hidden', on));
  $$('.zh-toggle').forEach(b => { if (b.dataset.act === 'zh') b.textContent = on ? '显示中文' : '收起中文'; });
  btn.dataset.on = on ? '0' : '1';
  btn.textContent = '整篇译文：' + (on ? '关' : '开');
}

/* ---------------- TTS ---------------- */
function loadVoices() {
  const all = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  voices = all.filter(v => /^en/i.test(v.lang));
  const sel = $('#ttsVoice');
  if (!sel) return;
  sel.innerHTML = voices.map(v => '<option value="' + esc(v.name) + '">' + esc(v.name + ' · ' + v.lang) + '</option>').join('')
    || '<option value="">系统默认</option>';
  const saved = DB.settings.ttsVoice;
  const chosen = voices.find(v => v.name === saved) || voices.find(v => /en-US/i.test(v.lang)) || voices[0];
  if (chosen) { sel.value = chosen.name; tts.voiceName = chosen.name; }
  sel.onchange = () => { DB.settings.ttsVoice = sel.value; tts.voiceName = sel.value; save(); restartSentence(); };
}

function ttsSupported() { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; }

function speakAt(i) {
  if (!ttsSupported()) return toast('此浏览器不支持朗读');
  if (i < 0 || i >= sentMap.length) return stopTTS();
  tts.idx = i;
  tts.playing = true;
  tts.paused = false;
  const btn = $('#ttsPlay'); if (btn) btn.textContent = '❚❚';
  highlightSentence(i);
  scrollToSentence(i);
  try { speechSynthesis.cancel(); } catch (e) {}
  const u = new SpeechSynthesisUtterance(sentMap[i].text);
  u.lang = 'en-US';
  u.rate = Number(($('#ttsRate') || {}).value) || 1;
  const v = voices.find(x => x.name === (tts.voiceName || DB.settings.ttsVoice)) || voices.find(x => /en-US/i.test(x.lang)) || voices[0];
  if (v) u.voice = v;
  u.onend = () => { if (tts.playing && !tts.paused) speakAt(i + 1); };
  u.onerror = (e) => {
    if (e && (e.error === 'interrupted' || e.error === 'canceled')) return;
    stopTTS();
    toast('朗读中断：' + ((e && e.error) || '浏览器限制'));
  };
  try { speechSynthesis.speak(u); }
  catch (e) { stopTTS(); toast('朗读启动失败'); }
}

function startTTS(i) {
  if (!ttsSupported()) return toast('此浏览器不支持朗读');
  if (!sentMap.length) return;
  tts.articleId = state.readerId;
  speakAt(i === undefined ? 0 : i);
}

function pauseTTS() {
  if (!ttsSupported()) return;
  tts.paused = true; tts.playing = false;
  try { speechSynthesis.pause(); } catch (e) {}
  const btn = $('#ttsPlay'); if (btn) btn.textContent = '▶';
}

function resumeTTS() {
  if (!ttsSupported()) return;
  tts.paused = false; tts.playing = true;
  const btn = $('#ttsPlay'); if (btn) btn.textContent = '❚❚';
  try {
    if (speechSynthesis.paused) speechSynthesis.resume();
    else speakAt(tts.idx);
  } catch (e) { speakAt(tts.idx); }
}

function stopTTS() {
  tts.playing = false; tts.paused = false;
  try { if (ttsSupported()) speechSynthesis.cancel(); } catch (e) {}
  const btn = $('#ttsPlay'); if (btn) btn.textContent = '▶';
  $$('.sent.hl').forEach(el => el.classList.remove('hl'));
}

function restartSentence() {
  if (tts.playing) speakAt(tts.idx);
}

function highlightSentence(i) {
  $$('.sent.hl').forEach(el => el.classList.remove('hl'));
  const el = $('.sent[data-sent="' + i + '"]');
  if (el) el.classList.add('hl');
}

function scrollToSentence(i) {
  const el = $('.sent[data-sent="' + i + '"]');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.top < 70 || rect.bottom > window.innerHeight - 130) {
    window.scrollBy({ top: rect.top - 110, behavior: 'smooth' });
  }
}

/* ---------------- 点词卡 ---------------- */
function showWordSheet(raw) {
  const targetDeck = DB.activeDeck;
  const info = lookupWord(raw, targetDeck);
  const key = wordKey(raw);
  const st = deckState(targetDeck);
  const known = !!st.srs[key];
  openSheet(
    '<div class="word-big">' + esc(raw) + '</div>' +
    '<div class="phon">' + esc(info ? info.p : '（词库中暂无音标）') + '</div>' +
    '<div class="mean">' + esc(info ? info.m : '这个词不在内置词库中，可加入生词本后自己补释义。') + '</div>' +
    '<div class="note">加入后进入「' + esc(deckData(targetDeck).meta.name) + '」的复习队列' + (known ? '（已在队列中）' : '') + '</div>' +
    '<div class="sheet-actions">' +
      '<button class="btn" data-act="speak-word" data-word="' + esc(raw) + '">🔊 发音</button>' +
      '<button class="btn primary" data-act="add-vocab" data-word="' + esc(raw) + '" data-deck="' + targetDeck + '"' + (known ? ' disabled' : '') + '>' + (known ? '已在生词本' : '加入生词本') + '</button>' +
    '</div>'
  );
}

function addVocab(raw, deckId) {
  const key = wordKey(raw);
  const dd = deckData(deckId);
  const info = lookupWord(raw, deckId);
  const st = deckState(deckId);
  if (!dd.map.has(key)) {
    st.custom.push([raw, info ? info.p : '', info ? info.m : '', '']);
    deckCache.delete(deckId);
    DICT = null;
  }
  st.srs[key] = { e: 2.5, i: 0, r: 0, l: 0, d: Date.now(), s: 'learn', last: Date.now(), added: true };
  save();
  toast('已加入「' + deckData(deckId).meta.name + '」学习队列');
  closeSheet();
  if (DB.activeDeck === deckId) {
    if (session.deck === deckId && session.queue) {
      if (!session.queue.includes(key)) session.queue.unshift(key);
    } else {
      session = { deck: deckId, queue: buildQueue(deckId), revealed: false };
    }
    renderStudy();
  }
}

/* ---------------- 弹层 / 对话框 ---------------- */
function openSheet(html) { $('#sheet').innerHTML = html; $('#sheetMask').hidden = false; }
function closeSheet() { $('#sheetMask').hidden = true; }
function openModal(html) { $('#modal').innerHTML = html; $('#modalMask').hidden = false; }
function closeModal() { $('#modalMask').hidden = true; }

/* ---------------- 导入导出 ---------------- */
function parseTable(text) {
  text = text.replace(/\r/g, '');
  const lines = text.split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const first = lines[0];
  const delim = (first.split('\t').length > first.split(',').length) ? '\t' : ',';
  const rows = [];
  lines.forEach(line => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === delim && !inQ) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map(c => c.trim()));
  });
  const head = rows[0].join('').toLowerCase();
  if (/单词|word|释义|meaning/.test(head)) rows.shift();
  return rows;
}

function importCsv(text, deckId) {
  const rows = parseTable(text);
  let added = 0, skipped = 0;
  const st = deckState(deckId);
  const dd = deckData(deckId);
  rows.forEach(r => {
    const w = (r[0] || '').trim();
    if (!w || !/[A-Za-z]/.test(w)) { skipped++; return; }
    const k = wordKey(w);
    if (dd.map.has(k)) {
      const entry = dd.map.get(k);
      if (r[2] && r[2] !== entry.m) { entry.m = r[2]; }
      skipped++;
      return;
    }
    st.custom.push([w, r[1] || '', r[2] || '', r[3] || '']);
    added++;
  });
  deckCache.delete(deckId);
  save();
  return { added: added, skipped: skipped };
}

function openCsvModal() {
  const deckName = deckData(DB.activeDeck).meta.name;
  openModal('<h2>导入 CSV 补词</h2><p class="note" style="margin-top:0">导入到「' + esc(deckName) + '」。列顺序：单词, 音标, 释义, 例句。也可先下载模板。</p>' +
    '<div class="field"><label>选择文件（.csv / .txt / .tsv）</label><input type="file" id="csvFile" accept=".csv,.txt,.tsv"></div>' +
    '<div class="field"><label>或直接粘贴</label><textarea class="input" id="csvText" placeholder="apple, /ˈæpl/, n. 苹果, I eat an apple."></textarea></div>' +
    '<div class="row"><button class="btn" data-act="csv-template">下载模板</button></div>' +
    '<div class="modal-actions"><button class="btn" data-act="close-modal">取消</button><button class="btn primary" data-act="do-import-csv">导入</button></div>');
  $('#csvFile').addEventListener('change', ev => {
    const f = ev.target.files[0]; if (!f) return;
    const fr = new FileReader();
    fr.onload = () => { $('#csvText').value = fr.result; };
    fr.readAsText(f, 'utf-8');
  });
}

function doExport() {
  const payload = { app: '词迹', v: 1, exportedAt: new Date().toISOString(), data: DB };
  download('词迹备份-' + today() + '.json', JSON.stringify(payload, null, 1));
  toast('备份已导出');
}

function openImportBackup() {
  openModal('<h2>从 JSON 恢复</h2><p class="note" style="margin-top:0">这会覆盖当前设备上的学习数据，建议先导出一次现有备份。</p>' +
    '<div class="field"><label>选择备份文件</label><input type="file" id="bkFile" accept=".json,application/json"></div>' +
    '<div class="modal-actions"><button class="btn" data-act="close-modal">取消</button><button class="btn primary" data-act="confirm-import-bk">选择文件并恢复</button></div>');
}

function importBackup(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const obj = JSON.parse(fr.result);
      const data = obj.data || obj;
      if (!data || data.v !== 1 || typeof data.decks !== 'object') throw new Error('不是本应用的备份文件');
      DB = normalize(data);
      save();
      deckCache.clear(); DICT = null; diffCache.clear();
      session = { deck: null, queue: [], revealed: false };
      applyClassicZh();
      closeModal();
      setPage('study');
      toast('恢复成功');
    } catch (e) { toast('恢复失败：' + e.message); }
  };
  fr.readAsText(file, 'utf-8');
}

/* 把备份里的经典文章译文合并回内存里的经典库 */
function applyClassicZh() {
  if (!DB.classicZh) return;
  Object.keys(DB.classicZh).forEach(id => {
    const c = CLASSIC.find(x => x.id === id);
    if (!c) return;
    Object.keys(DB.classicZh[id]).forEach(pi => {
      const i = Number(pi);
      if (c.paragraphs[i]) c.paragraphs[i].zh = DB.classicZh[id][pi];
    });
  });
}

/* ---------------- AI 翻译 ---------------- */
async function aiTranslate(texts) {
  const s = DB.settings;
  if (!s.aiBase || !s.aiKey || !s.aiModel) throw new Error('未配置 AI 接口');
  const r = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: s.aiBase, key: s.aiKey, model: s.aiModel, texts: texts })
  });
  if (!r.ok) {
    let msg = '翻译请求失败（' + r.status + '）';
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  const j = await r.json();
  if (!Array.isArray(j.texts)) throw new Error('翻译返回格式异常');
  return j.texts;
}

async function translateParagraph(pi) {
  const art = getArticle(state.readerId);
  if (!art) return;
  if (!DB.settings.aiKey) return toast('先在设置里配置 AI 接口，或导入时粘贴译文');
  const btn = $('.zh-toggle[data-p="' + pi + '"]');
  const original = art.paragraphs[pi].zh;
  if (original) return toggleParagraphZh(pi);
  if (btn) btn.outerHTML = '<span class="note" id="tr-' + pi + '"><span class="spin"></span> 翻译中…</span>';
  try {
    const out = await aiTranslate([art.paragraphs[pi].en]);
    setArticleParagraphZh(art, pi, out[0]);
    renderReader(getArticle(state.readerId));
  } catch (e) {
    renderReader(getArticle(state.readerId));
    toast('翻译失败：' + e.message);
  }
}

function setArticleParagraphZh(art, pi, zh) {
  if (art.tab === 'classic') {
    const c = CLASSIC.find(x => x.id === art.id);
    if (c && c.paragraphs[pi]) c.paragraphs[pi].zh = zh;
    DB.classicZh = DB.classicZh || {};
    DB.classicZh[art.id] = DB.classicZh[art.id] || {};
    DB.classicZh[art.id][pi] = zh;
  } else {
    const u = DB.articles.find(x => x.id === art.id);
    if (u) u.paragraphs[pi].zh = zh;
  }
  save();
}

async function translateWholeArticle() {
  const art = getArticle(state.readerId);
  if (!art) return;
  if (!DB.settings.aiKey) return toast('先把译文粘贴进来，或在设置里配置 AI 接口');
  const missing = art.paragraphs.map((p, i) => p.zh ? null : i).filter(i => i !== null);
  if (!missing.length) return toast('整篇已有译文');
  toast('开始翻译 ' + missing.length + ' 段，请稍候…');
  for (const i of missing) {
    try {
      const out = await aiTranslate([art.paragraphs[i].en]);
      setArticleParagraphZh(art, i, out[0]);
      art._diff = null;
    } catch (e) {
      toast('翻译中断：' + e.message);
      break;
    }
  }
  renderReader(getArticle(state.readerId));
}

/* ---------------- 事件绑定 ---------------- */
document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]');
  const tabBtn = ev.target.closest('.tab');
  if (tabBtn) { closeReader(); setPage(tabBtn.dataset.page); return; }
  const seg = ev.target.closest('.seg-btn');
  if (seg) { state.readTab = seg.dataset.tab; renderReading(); return; }

  // 点句子 / 点单词
  const wordEl = ev.target.closest('.w');
  if (wordEl && state.readerId) {
    ev.stopPropagation();
    $$('.w.active').forEach(x => x.classList.remove('active'));
    wordEl.classList.add('active');
    const art = getArticle(state.readerId);
    showWordSheet(wordEl.dataset.w, art ? analyze(art) : null);
    return;
  }
  const sentEl = ev.target.closest('.sent');
  if (sentEl && state.readerId) {
    const i = Number(sentEl.dataset.sent);
    tts.paused = false;
    $('#ttsPlay').textContent = '❚❚';
    startTTS(i);
    return;
  }

  if (!el) return;
  const act = el.dataset.act;
  if (act === 'reveal') { session.revealed = true; renderStudy(); }
  else if (act === 'rate') rate(Number(el.dataset.q));
  else if (act === 'speak-word') speakWord(el.dataset.word || (currentWord() || {}).w || '');
  else if (act === 'restart-day') {
    DB.settings.dailyNew = clamp((DB.settings.dailyNew || 20) + 5, 0, 200);
    save();
    session = { deck: null, queue: [], revealed: false };
    renderStudy();
    toast('每日新词上限 +5，后面几天的安排会跟着变');
  }
  else if (act === 'go-reading') setPage('reading');
  else if (act === 'open') openReader(el.dataset.id);
  else if (act === 'rss-load') loadRss(el.dataset.src);
  else if (act === 'rss-custom') { const v = ($('#customRss').value || '').trim(); if (!v) return toast('请填写 RSS 地址'); loadRss('custom', v); }
  else if (act === 'open-news') openNews(el.dataset.src, Number(el.dataset.i));
  else if (act === 'extract-url') {
    const v = ($('#pasteUrl').value || '').trim();
    if (!v) return toast('请填写链接');
    openImportModal({ url: v });
    extractFromUrl(v, $('#imText'), $('#imTitle'));
  }
  else if (act === 'import-article') openImportModal({});
  else if (act === 'del-article') { DB.articles = DB.articles.filter(a => a.id !== el.dataset.id); save(); renderReading(); toast('已删除'); }
  else if (act === 'zh') toggleParagraphZh(Number(el.dataset.p));
  else if (act === 'translate-para') translateParagraph(Number(el.dataset.p));
  else if (act === 'add-vocab') addVocab(el.dataset.word, el.dataset.deck);
  else if (act === 'switch-deck') switchDeck(el.dataset.deck);
  else if (act === 'new-minus') changeDailyNew(-5);
  else if (act === 'new-plus') changeDailyNew(5);
  else if (act === 'test-voice') speakWord('hello');
  else if (act === 'import-csv') openCsvModal();
  else if (act === 'do-import-csv') {
    const txt = ($('#csvText').value || '').trim();
    if (!txt) return toast('没有可导入的内容');
    const r = importCsv(txt, DB.activeDeck); closeModal(); toast('导入 ' + r.added + ' 词，跳过 ' + r.skipped);
    session = { deck: null, queue: [], revealed: false }; renderStudy(); renderSettings();
  }
  else if (act === 'csv-template') download('单词模板.csv', '单词,音标,释义,例句\napple,/ˈæpl/,n. 苹果,I eat an apple every day.\n');
  else if (act === 'export-json') doExport();
  else if (act === 'import-json') openImportBackup();
  else if (act === 'confirm-import-bk') { const f = $('#bkFile').files[0]; if (!f) return toast('请选择备份文件'); importBackup(f); }
  else if (act === 'save-ai') {
    DB.settings.aiBase = $('#aiBase').value.trim();
    DB.settings.aiModel = $('#aiModel').value.trim();
    DB.settings.aiKey = $('#aiKey').value.trim();
    save(); toast('已保存翻译设置');
  }
  else if (act === 'close-modal') closeModal();
  else if (act === 'save-article') saveArticleFromModal();
  else if (act === 'extract-modal') {
    const url = ($('#imUrl').value || '').trim();
    if (!url) return toast('请先填链接');
    extractFromUrl(url, $('#imText'), $('#imTitle'));
  }
  else if (act === 'choose-deck') { const id = el.dataset.deck; DB.activeDeck = id; DB.onboard = true; save(); closeModal(); session = { deck: null, queue: [], revealed: false }; setPage('study'); }
});

function speakWord(w) {
  if (!w) return;
  if (!ttsSupported()) return toast('此浏览器不支持朗读');
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(w);
    u.lang = 'en-US';
    u.rate = 0.95;
    const v = voices.find(x => /en-US/i.test(x.lang)) || voices[0];
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch (e) { toast('发音失败'); }
}

function switchDeck(id) {
  closeSheet();
  if (id === DB.activeDeck) return;
  DB.activeDeck = id; save();
  session = { deck: null, queue: [], revealed: false };
  const name = deckData(id).meta.name;
  toast('已切换到「' + name + '」，进度独立保存');
  if (state.page === 'study') renderStudy();
  else if (state.page === 'settings') renderSettings();
}

function changeDailyNew(delta) {
  DB.settings.dailyNew = clamp((DB.settings.dailyNew || 20) + delta, 0, 100);
  save();
  if ($('#newLimit')) $('#newLimit').textContent = DB.settings.dailyNew;
  session = { deck: null, queue: [], revealed: false };
  renderStudy();
}

/* 顶部词库按钮 */
$('#deckChipBtn').addEventListener('click', () => {
  openSheet('<h2>切换词库</h2><p class="note" style="margin-top:0">每个词库进度独立，切换不清空对方。</p><div class="deck-choose">' +
    DECKS.map(d => '<button class="deck-choice" data-act="switch-deck" data-deck="' + d.id + '"><b>' + esc(d.name) + (d.id === DB.activeDeck ? ' ✓' : '') + '</b><span>' + deckTotal(d.id) + ' 词</span></button>').join('') +
    '</div><div class="modal-actions"><button class="btn" data-act="close-sheet">关闭</button></div>');
  $('#sheet').addEventListener('click', ev => { if (ev.target.closest('[data-act="close-sheet"]')) closeSheet(); }, { once: true });
});
$('#startStudyBtn').addEventListener('click', () => { session = { deck: null, queue: [], revealed: false }; renderStudy(); });
$('#goReadingBtn').addEventListener('click', () => setPage('reading'));
$('#sheetMask').addEventListener('click', ev => { if (ev.target === $('#sheetMask')) closeSheet(); });
$('#modalMask').addEventListener('click', ev => { if (ev.target === $('#modalMask')) closeModal(); });
$('#readerBack').addEventListener('click', () => closeReader());
$('#readerFontBtn').addEventListener('click', () => {
  DB.settings.artSize = ((DB.settings.artSize || 0) + 1) % 3;
  save(); $('#readerFontBtn').textContent = ['A−', 'A', 'A+'][DB.settings.artSize]; applyArtSize();
});
$('#toggleAllZh').addEventListener('click', () => {
  const art = getArticle(state.readerId);
  if (!art) return;
  if (!art.paragraphs.some(p => p.zh)) {
    if (DB.settings.aiKey) return translateWholeArticle();
    return toast('这篇文章还没有译文：可导入时粘贴译文，或在设置里配置 AI 接口');
  }
  toggleAllZh();
});
$('#ttsPlay').addEventListener('click', () => {
  if (tts.playing) pauseTTS();
  else if (tts.paused) resumeTTS();
  else startTTS(0);
});
$('#ttsPrev').addEventListener('click', () => { if (!sentMap.length) return; tts.playing = true; tts.paused = false; speakAt(Math.max(0, tts.idx - 1)); });
$('#ttsNext').addEventListener('click', () => { if (!sentMap.length) return; tts.playing = true; tts.paused = false; speakAt(Math.min(sentMap.length - 1, tts.idx + 1)); });
$('#ttsRate').addEventListener('change', () => { DB.settings.ttsRate = Number($('#ttsRate').value); save(); restartSentence(); });

document.addEventListener('visibilitychange', () => {
  if (document.hidden && tts.playing) { pauseTTS(); }
});

/* 初始化 */
function init() {
  $('#ttsRate').value = String(DB.settings.ttsRate || 1);
  if (window.speechSynthesis) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }
  applyClassicZh();
  setPage('study');
  if (!DB.onboard) {
    setTimeout(() => {
      openModal('<h2>先选一个起点</h2><p class="note" style="margin-top:0">之后随时可切换，各阶段进度独立保存。建议选已学过的最基础一档。</p><div class="deck-choose">' +
        DECKS.map(d => '<button class="deck-choice" data-act="choose-deck" data-deck="' + d.id + '"><b>' + esc(d.name) + '</b><span>' + deckTotal(d.id) + ' 词 · 每日 20 新词</span></button>').join('') +
        '</div>');
    }, 300);
  }
}

init();

/* Service Worker */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

})();
