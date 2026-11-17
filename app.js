// 移動運用ログ（field-log）。山や公園の移動運用で、スマホの Chrome で交信を記録する。
// 記録はこの端末のブラウザーの中（localStorage）だけに保存し、ADIF で書き出す。外部へは何も送らない。
// IC-705 には Web Bluetooth（BLE）でつなぎ、周波数とモードを読むだけ（つなぎ方は ic705-bt/ と同じ）。
'use strict';

const APP_VER = '2026-11-17-4'; // 変えたら sw.js の CACHE も同じ名前に変える
const STORE = 'fieldlog.v1';    // 記録を入れておく localStorage のキー

const $ = (id) => document.getElementById(id);
const p2 = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ===================== 記録（運用ごと） =====================
// db = { cur: 今の運用の id, acts: [運用…], form: { freq, mode } }
// 運用 = { id, created, info: { call, grid, sota, jcc, parks: [3つ] }, qsos: [交信…], changedAt, exportedAt }
// 交信 = { id, call, date: 'YYYYMMDD'(UTC), time: 'HHMMSS'(UTC), freq: 'MHz'（空のこともある）, band, mode, rstS, rstR, sota, pota, grid, comment }
let db = { cur: null, acts: [], form: { freq: '', mode: 'CW' } };

function loadDb() {
  try {
    const s = localStorage.getItem(STORE);
    if (!s) return;
    const d = JSON.parse(s);
    if (d && Array.isArray(d.acts)) db = Object.assign({ form: { freq: '', mode: 'CW' } }, d);
  } catch (e) {
    showMsg('保存してある記録を読めませんでした。', true);
  }
}
function saveDb() {
  try {
    localStorage.setItem(STORE, JSON.stringify(db));
    return true;
  } catch (e) {
    showMsg('保存できませんでした。すぐに「この運用の交信」の「ADIF を書き出す」で書き出してください。', true);
    return false;
  }
}
const curAct = () => db.acts.find((a) => a.id === db.cur) || null;
function newAct(info) {
  const a = {
    id: uid(), created: Date.now(),
    info: info || { call: '', grid: '', sota: '', jcc: '', parks: ['', '', ''] },
    qsos: [], changedAt: 0, exportedAt: 0,
  };
  db.acts.unshift(a);
  db.cur = a.id;
  saveDb();
  return a;
}
// ブラウザーが空き容量の都合で勝手に記録を消さないように頼む（Android の Chrome。断られても動く）
function askPersist() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* 無視 */ }
}

// ===================== 時刻・周波数・バンド =====================
function utcNow(d = new Date()) {
  return {
    date: `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`,
    time: `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`,
  };
}
const fmtTime = (t) => (t ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : '--:--');
const fmtDate = (d) => (d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '');

// ADIF のバンド（MHz の範囲）
const BANDS = [
  ['2190m', 0.1357, 0.1378], ['630m', 0.472, 0.479], ['160m', 1.8, 2.0], ['80m', 3.5, 4.0], ['60m', 5.06, 5.45],
  ['40m', 7.0, 7.3], ['30m', 10.1, 10.15], ['20m', 14.0, 14.35], ['17m', 18.068, 18.168], ['15m', 21.0, 21.45],
  ['12m', 24.89, 24.99], ['10m', 28.0, 29.7], ['6m', 50, 54], ['2m', 144, 148], ['1.25m', 222, 225],
  ['70cm', 420, 450], ['23cm', 1240, 1300],
];
function bandOf(mhz) {
  const f = parseFloat(mhz);
  if (!(f > 0)) return '';
  const b = BANDS.find(([, lo, hi]) => f >= lo && f <= hi);
  return b ? b[0] : '';
}
// 入れた周波数を MHz の文字にそろえる（7003.5 のように kHz で入れても MHz にする）。小数は 3 桁以上、最後の 0 は消す
function mhzStr(mhz) {
  let s = mhz.toFixed(6);
  while (s.endsWith('0') && s.split('.')[1].length > 3) s = s.slice(0, -1);
  return s;
}
function freqNorm(text) {
  const t = String(text || '').trim().replace(',', '.');
  let f = parseFloat(t);
  if (!(f > 0)) return '';
  if (f >= 1000) f /= 1000;   // kHz で入れたとき
  return mhzStr(f);
}

// モードごとの RST の初めの値（FT8・FT4 は空にしておく）
const RST_DEF = { CW: '599', RTTY: '599', SSB: '59', FM: '59', AM: '59', DSTAR: '59', FT8: '', FT4: '' };
const normCall = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
// コールサインらしい形か（英字と数字を両方含む 3 文字以上）。おかしくても記録はするが、一覧で赤く出す
const callOk = (c) => /^[A-Z0-9/]{3,}$/.test(c) && /[0-9]/.test(c) && /[A-Z]/.test(c);
const normRef = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');

// ===================== 入力欄 =====================
let rstTouched = false;   // RST を手で直したら、モードを変えても上書きしない
function showMsg(text, err = false) {
  const el = $('msg');
  el.textContent = text;
  el.classList.toggle('err', err);
}
function setDefaultRst(force = false) {
  if (rstTouched && !force) return;
  const r = RST_DEF[$('mode').value] ?? '59';
  $('rstS').value = r;
  $('rstR').value = r;
  rstTouched = false;
}
function onFreqChanged() {
  $('band').textContent = bandOf(freqNorm($('freq').value)) || '--';
  updateDupe();
}
function rememberForm() {
  db.form = { freq: $('freq').value.trim(), mode: $('mode').value };
  saveDb();
}
function clearEntry() {
  for (const id of ['call', 'sotaRef', 'potaRef', 'grid', 'comment']) $(id).value = '';
  setDefaultRst(true);
  updateDupe();
}

// 同じ局とこの運用ですでに交信していたら知らせる（同じバンド・モードなら赤）
function updateDupe() {
  const el = $('dupe'), a = curAct(), call = normCall($('call').value);
  if (!a || call.length < 3) { el.hidden = true; return; }
  const hits = a.qsos.filter((q) => q.call === call);
  if (!hits.length) { el.hidden = true; return; }
  const band = bandOf(freqNorm($('freq').value)), mode = $('mode').value;
  const same = hits.some((q) => q.band === band && q.mode === mode);
  el.className = 'dupe' + (same ? ' bad' : '');
  el.textContent = (same ? '重複: 同じバンド・モードで交信済み　' : 'この運用で交信済み　')
    + hits.map((q) => `${fmtTime(q.time)} ${q.band || '?'} ${q.mode}`).join('、');
  el.hidden = false;
}

function logQso() {
  const a = curAct() || newAct(null);
  const call = normCall($('call').value);
  if (!call) {
    showMsg('相手のコールサインを入れてください。', true);
    $('call').focus();
    return;
  }
  // 周波数は空でも記録する（あとで一覧から直せる）。入れた周波数は消さずに次の交信にも使う
  const freq = freqNorm($('freq').value);
  const { date, time } = utcNow();
  const q = {
    id: uid(), call, date, time, freq, band: bandOf(freq), mode: $('mode').value,
    rstS: $('rstS').value.trim(), rstR: $('rstR').value.trim(),
    sota: normRef($('sotaRef').value), pota: normRef($('potaRef').value),
    grid: $('grid').value.trim(), comment: $('comment').value.trim(),
  };
  a.qsos.push(q);
  a.changedAt = Date.now();
  if (a.qsos.length === 1) askPersist();
  if (saveDb()) {
    const warn = [callOk(call) ? '' : 'コールサインの形を確かめてください', freq ? '' : '周波数が空です'].filter(Boolean).join('・');
    showMsg(`${call} を記録しました（${fmtTime(time)} UTC）。` + (warn ? `${warn}（一覧から直せます）。` : ''), !!warn);
  }
  if (freq) $('freq').value = freq;
  rememberForm();
  clearEntry();
  render();
  $('call').focus();
}

// ===================== 一覧 =====================
function actTitle(a) {
  const i = a.info, parks = i.parks.filter(Boolean);
  const parts = [];
  if (i.sota) parts.push(i.sota);
  if (parks.length) parts.push(parks.join(' '));
  return parts.join(' / ');
}
function render() {
  const a = curAct();
  const qsos = a ? a.qsos : [];
  const title = a ? actTitle(a) : '';
  $('actSummary').textContent = a ? [a.info.call, title, a.info.jcc].filter(Boolean).join('  ') || '（運用の情報なし）' : '';
  $('countTop').textContent = `${qsos.length} 交信`;
  $('countList').textContent = qsos.length ? `（${qsos.length}）` : '';
  $('empty').hidden = qsos.length > 0;
  const list = $('list');
  list.textContent = '';
  for (let i = qsos.length - 1; i >= 0; i--) {
    const q = qsos[i];
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const span = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; b.appendChild(s); };
    span('no', String(i + 1));
    span(callOk(q.call) ? 'cs' : 'cs badcall', q.call);
    span('tm', `${fmtTime(q.time)} UTC`);
    span('no', '');
    const det = [q.freq, q.band, q.mode, (q.rstS || q.rstR) ? `${q.rstS || '-'}/${q.rstR || '-'}` : ''];
    if (q.sota) det.push('S2S ' + q.sota);
    if (q.pota) det.push('P2P ' + q.pota);
    if (q.grid) det.push(q.grid);
    if (q.comment) det.push(q.comment);
    span('dt', det.filter(Boolean).join('  '));
    b.addEventListener('click', () => openQso(q.id));
    li.appendChild(b);
    list.appendChild(li);
  }
  renderExportInfo();
  updateDupe();
}

// ===================== 確認の画面 =====================
function ask(text, yes = 'OK') {
  return new Promise((resolve) => {
    const dlg = $('askDlg');
    $('askText').textContent = text;
    $('askYes').textContent = yes;
    const done = (v) => { cleanup(); if (dlg.open) dlg.close(); resolve(v); };
    const onYes = () => done(true), onNo = () => done(false), onClose = () => done(false);
    function cleanup() {
      $('askYes').removeEventListener('click', onYes);
      $('askNo').removeEventListener('click', onNo);
      dlg.removeEventListener('close', onClose);
    }
    $('askYes').addEventListener('click', onYes);
    $('askNo').addEventListener('click', onNo);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

// ===================== 交信を直す =====================
let editId = null;
const E = { call: 'eCall', mode: 'eMode', date: 'eDate', time: 'eTime', freq: 'eFreq', rstS: 'eRstS', rstR: 'eRstR',
  sota: 'eSota', pota: 'ePota', grid: 'eGrid', comment: 'eComment' };
function openQso(id) {
  const a = curAct(), q = a && a.qsos.find((x) => x.id === id);
  if (!q) return;
  editId = id;
  for (const [k, el] of Object.entries(E)) $(el).value = q[k] || '';
  $('eBand').textContent = q.band || '--';
  $('eMsg').textContent = '';
  $('qsoDlg').showModal();
}
$('eFreq').addEventListener('input', () => { $('eBand').textContent = bandOf(freqNorm($('eFreq').value)) || '--'; });
$('eCancel').addEventListener('click', () => $('qsoDlg').close());
$('eSave').addEventListener('click', () => {
  const a = curAct(), q = a && a.qsos.find((x) => x.id === editId);
  if (!q) { $('qsoDlg').close(); return; }
  const call = normCall($('eCall').value);
  let time = $('eTime').value.trim().replace(/:/g, '');
  const date = $('eDate').value.trim().replace(/-/g, '');
  const freq = freqNorm($('eFreq').value);
  if (time.length === 4) time += '00';
  const err = !call ? 'コールサインを入れてください。'
    : !/^\d{8}$/.test(date) ? '日付は 20261108 のように 8 けたで入れてください。'
    : !/^([01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(time) ? '時刻は 0205 か 020544 のように入れてください（UTC）。' : '';
  if (err) { $('eMsg').textContent = err; return; }
  Object.assign(q, {
    call, date, time, freq, band: bandOf(freq), mode: $('eMode').value,
    rstS: $('eRstS').value.trim(), rstR: $('eRstR').value.trim(),
    sota: normRef($('eSota').value), pota: normRef($('ePota').value),
    grid: $('eGrid').value.trim(), comment: $('eComment').value.trim(),
  });
  a.qsos.sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
  a.changedAt = Date.now();
  saveDb();
  $('qsoDlg').close();
  render();
});
$('eDel').addEventListener('click', async () => {
  const a = curAct(), q = a && a.qsos.find((x) => x.id === editId);
  if (!q) return;
  $('qsoDlg').close();
  if (await ask(`${q.call}（${fmtTime(q.time)} UTC）の交信を削除します。元に戻せません。`, '削除する')) {
    a.qsos = a.qsos.filter((x) => x.id !== editId);
    a.changedAt = Date.now();
    saveDb();
    render();
    showMsg(`${q.call} の交信を削除しました。`);
  } else {
    $('qsoDlg').showModal();
  }
});

// ===================== 画面の切り替え =====================
// 画面は 3 つ: list（運用の一覧。メイン画面）、info（今の運用の情報を入れる・直す）、log（交信の記録）。
// スマホの「戻る」でも一覧へ戻れるように、一覧以外の画面はブラウザーの履歴を 1 つだけ積む。
let view = 'list';
let editing = null;   // 'new'（新しい運用。保存するまで作らない）か、直している運用の id
function showView(v) {
  view = v;
  $('listView').hidden = v !== 'list';
  $('infoView').hidden = v !== 'info';
  $('logView').hidden = v !== 'log';
  $('backBtn').hidden = v === 'list';
  $('actBtn').hidden = v !== 'log';
  $('actSummary').hidden = v !== 'log';
  $('ttl').textContent = v === 'list' ? '移動運用ログ' : v === 'info' ? (editing === 'new' ? '新しい運用' : '運用の情報') : '交信の記録';
  window.scrollTo(0, 0);
}
// 一覧へ戻るときは積んだ履歴を戻す。戻り終わる（popstate が届く）前に次の画面へ進んだときは、履歴を積むのを戻り終わるまで待つ
let backPending = false, deferredState = null;
function finishBack() {
  backPending = false;
  if (deferredState) { history.pushState(deferredState, ''); deferredState = null; }
}
function go(v) {
  if (v === 'list') {
    const st = history.state;
    showView('list');
    renderActList();
    if (!backPending && st && st.fieldlog && st.view !== 'list') {
      backPending = true;
      history.back();
      setTimeout(() => { if (backPending) finishBack(); }, 1500);   // 知らせが届かなかったとき
    }
    return;
  }
  const st = { fieldlog: true, view: v };
  if (backPending) deferredState = st;
  else if (view === 'list') history.pushState(st, '');
  else history.replaceState(st, '');
  showView(v);
}
// スマホの「戻る」: 運用の情報の画面なら、直した内容を保存してから戻る（新しい運用は作らない）
window.addEventListener('popstate', (e) => {
  if (backPending) { finishBack(); return; }   // go('list') が戻したときの知らせ
  const v = (e.state && e.state.fieldlog && e.state.view) || 'list';
  if (v === view) return;
  if (view === 'info') commitInfo(false);
  if (v === 'list' || !curAct()) { showView('list'); renderActList(); } else { render(); showView('log'); }
});

// ===================== 運用の一覧（メイン画面） =====================
function renderActList() {
  const ul = $('actList');
  ul.textContent = '';
  $('actEmpty').hidden = db.acts.length > 0;
  for (const a of db.acts) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    if (a.id === db.cur) b.className = 'cur';
    const first = a.qsos[0];
    const day = first ? fmtDate(first.date) + ' UTC' : new Date(a.created).toLocaleDateString();
    b.textContent = actTitle(a) || a.info.jcc || '（山頂・公園なし）';
    const sub = document.createElement('span');
    sub.className = 'sub2';
    const saved = a.qsos.length && a.exportedAt >= a.changedAt ? '書き出し済み' : (a.qsos.length ? '書き出していない変更あり' : '');
    sub.textContent = [day, `${a.qsos.length} 交信`, a.info.call, saved].filter(Boolean).join('　');
    b.appendChild(sub);
    b.addEventListener('click', () => openAct(a.id));
    li.appendChild(b);
    ul.appendChild(li);
  }
}
// 一覧の運用を押す → その運用の記録の画面へ
function openAct(id) {
  db.cur = id;
  saveDb();
  showMsg('');
  clearEntry();
  render();
  go('log');
}

// ===================== 今の運用（運用の情報） =====================
function fillInfo(info) {
  $('aCall').value = info.call || '';
  $('aGrid').value = info.grid || '';
  $('aSota').value = info.sota || '';
  $('aJcc').value = info.jcc || '';
  ['aPark1', 'aPark2', 'aPark3'].forEach((el, i) => { $(el).value = info.parks[i] || ''; });
}
function readInfo() {
  const info = {
    call: normCall($('aCall').value), grid: $('aGrid').value.trim(), sota: normRef($('aSota').value),
    jcc: normRef($('aJcc').value),
    parks: ['aPark1', 'aPark2', 'aPark3'].map((el) => normRef($(el).value)).filter(Boolean),
  };
  while (info.parks.length < 3) info.parks.push('');
  return info;
}
// 一覧の「新しい運用を始める」→ 今の運用の画面。自分のコールサインとグリッドは、いちばん新しい運用から引き継ぐ
function openNewAct() {
  editing = 'new';
  const last = db.acts[0];
  fillInfo({ call: last ? last.info.call : '', grid: last ? last.info.grid : '', sota: '', jcc: '', parks: ['', '', ''] });
  $('infoTitle').textContent = '新しい運用';
  $('aSave').textContent = '保存して記録を始める';
  $('aBack').hidden = false;
  $('delActBtn').hidden = true;
  go('info');
  ($('aCall').value ? $('aSota') : $('aCall')).focus();
}
// 記録の画面の上の帯を押す → 今の運用の情報を直す
function openEditAct() {
  const a = curAct();
  if (!a) return;
  editing = a.id;
  fillInfo(a.info);
  $('infoTitle').textContent = '運用の情報';
  $('aSave').textContent = '保存して記録へ戻る';
  $('aBack').hidden = true;
  $('delActBtn').hidden = false;
  go('info');
}
// 欄の内容を保存する。新しい運用は「保存」を押したとき（make = true）だけ作る。保存した運用を返す
function commitInfo(make) {
  if (editing === null) return null;
  const info = readInfo();
  let a = null;
  if (editing === 'new') {
    if (make) a = newAct(info);
  } else {
    a = db.acts.find((x) => x.id === editing) || null;
    if (a && JSON.stringify(info) !== JSON.stringify(a.info)) {
      a.info = info;
      a.changedAt = Date.now();
      saveDb();
    }
  }
  editing = null;
  return a;
}
$('newActBtn').addEventListener('click', openNewAct);
$('actBtn').addEventListener('click', openEditAct);
$('actForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const a = commitInfo(true);
  if (!a) { go('list'); return; }
  db.cur = a.id;
  saveDb();
  showMsg('');
  render();
  go('log');
});
$('aBack').addEventListener('click', () => { commitInfo(false); go('list'); });
// 上の「戻る」: 運用の情報の画面からは（直していれば保存して）元の画面へ、記録の画面からは一覧へ
$('backBtn').addEventListener('click', () => {
  if (view === 'info') {
    const wasNew = editing === 'new';
    commitInfo(false);
    if (wasNew || !curAct()) go('list');
    else { render(); go('log'); }
  } else go('list');
});
$('toListBtn').addEventListener('click', () => go('list'));
$('delActBtn').addEventListener('click', async () => {
  const a = db.acts.find((x) => x.id === editing);
  if (!a) return;
  const name = actTitle(a) || '山頂・公園なし';
  const warn = a.qsos.length && a.exportedAt < a.changedAt ? 'まだ書き出していない変更があります。' : '';
  if (await ask(`運用「${name}」（${a.qsos.length} 交信）を削除します。${warn}元に戻せません。`, '削除する')) {
    editing = null;
    db.acts = db.acts.filter((x) => x.id !== a.id);
    if (db.cur === a.id) db.cur = null;
    saveDb();
    go('list');
  }
});
function renderExportInfo() {
  const a = curAct();
  const n = a ? a.qsos.length : 0;
  $('exportBtn').disabled = n === 0;
  $('shareBtn').disabled = n === 0;
  $('exportInfo').textContent = n === 0 ? ''
    : `ファイル名: ${fileName(a)}　`
      + (a.exportedAt >= a.changedAt ? '書き出し済み（その後の変更なし）' : 'まだ書き出していない交信・変更があります');
}

// ===================== ADIF の書き出し =====================
const enc = new TextEncoder();
const fld = (name, value) => (value ? `<${name}:${enc.encode(value).length}>${value} ` : '');
// ログのモード → ADIF の MODE と SUBMODE
const ADIF_MODE = { DSTAR: ['DIGITALVOICE', 'DSTAR'], FT4: ['MFSK', 'FT4'] };
function adifText(a) {
  const i = a.info, parks = i.parks.filter(Boolean);
  const now = new Date().toISOString();
  let s = `Field Log ${APP_VER} ${now}\n${fld('ADIF_VER', '3.1.4')}\n${fld('PROGRAMID', 'FieldLog')}\n${fld('PROGRAMVERSION', APP_VER)}\n<EOH>\n\n`;
  const qsos = a.qsos.slice().sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
  for (const q of qsos) {
    const [mode, sub] = ADIF_MODE[q.mode] || [q.mode, ''];
    s += (fld('CALL', q.call) + fld('STATION_CALLSIGN', i.call) + fld('BAND', q.band) + fld('MODE', mode) + fld('SUBMODE', sub)
      + fld('FREQ', q.freq) + fld('MY_GRIDSQUARE', i.grid) + fld('MY_SOTA_REF', i.sota)
      + fld('MY_SIG', parks.length ? 'POTA' : '') + fld('MY_SIG_INFO', parks.join(','))
      + fld('QSO_DATE', q.date) + fld('TIME_ON', q.time) + fld('RST_RCVD', q.rstR) + fld('RST_SENT', q.rstS)
      + fld('SOTA_REF', q.sota) + fld('SIG', q.pota ? 'POTA' : '') + fld('SIG_INFO', q.pota)
      + fld('GRIDSQUARE', q.grid) + fld('COMMENT', q.comment)).trimEnd() + ' <EOR>\n';
  }
  return s;
}
// ファイル名: 日付-山頂-公園1-jcg-番号.adi（すべて小文字、/ は -）。ADIF一括編集ツールがファイル名から JCC/JCG を読めるように
function fileName(a) {
  const i = a.info;
  const first = a.qsos.slice().sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time))[0];
  const parts = [first ? first.date : utcNow().date];
  if (i.sota) parts.push(i.sota);
  if (i.parks[0]) parts.push(i.parks[0]);
  const m = i.jcc.match(/^(JC[CG])[-_ ]?([0-9][0-9A-Z]*)$/);
  if (m) parts.push(m[1] + '-' + m[2]);
  return parts.join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-') + '.adi';
}
function markExported(a) {
  a.exportedAt = Date.now();
  saveDb();
  renderExportInfo();
  renderActList();
}
$('exportBtn').addEventListener('click', () => {
  const a = curAct();
  if (!a || !a.qsos.length) return;
  const blob = new Blob([adifText(a)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName(a);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  markExported(a);
});
// ほかのアプリへ送る（Android の共有。Google ドライブ・Gmail など、選んだアプリにだけ渡す）
function shareFile(a) {
  return new File([adifText(a)], fileName(a), { type: 'text/plain' });
}
try {
  if (navigator.canShare && navigator.canShare({ files: [new File(['x'], 'test.adi', { type: 'text/plain' })] })) $('shareBtn').hidden = false;
} catch (e) { /* 共有できない端末 */ }
$('shareBtn').addEventListener('click', async () => {
  const a = curAct();
  if (!a || !a.qsos.length) return;
  try {
    await navigator.share({ files: [shareFile(a)], title: fileName(a) });
    markExported(a);
  } catch (e) {
    if (e.name !== 'AbortError') $('exportInfo').textContent = '送れませんでした: ' + e.message;
  }
});

// ===================== IC-705（Web Bluetooth） =====================
const SERVICE_UUID = '14cf8001-1ec2-d408-1b04-2eb270f14203';
const CHAR_UUID = '14cf8002-1ec2-d408-1b04-2eb270f14203';
const RADIO_ADDR = 0xA4, CTRL_ADDR = 0xE0;
const POLL_MS = 1000;   // 周波数とモードを読む間隔（ログには 1 秒で十分。電池のため）
// IC-705 コントローラー（ic705-bt）と同じ名前と番号を使う。本体は名前と番号の組で機器を見分けるので、
// 同じアドレス（nqf18003.github.io）で開けば、同じ Bluetooth の枠を使い、ペアリングし直さなくてよい（見込み）。
const APP_NAME = 'IC705 BT Reader';
function clientId() {
  let id = null;
  try { id = localStorage.getItem('ic705bt.clientId'); } catch (e) { /* 無視 */ }
  if (!id || id.length !== 36) {
    id = (crypto.randomUUID ? crypto.randomUUID() : '56a56730-e8bc-4900-81b6-ef33e973842b').toUpperCase();
    try { localStorage.setItem('ic705bt.clientId', id); } catch (e) { /* 無視 */ }
  }
  return id;
}
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0x7f);
function bcdToHz(bytes) {
  let hz = 0, scale = 1;
  for (const b of bytes) { hz += (b & 0x0f) * scale; scale *= 10; hz += (b >> 4) * scale; scale *= 10; }
  return hz;
}
function hzToBcd(hz) {
  const out = [];
  for (let i = 0; i < 5; i++) { const lo = hz % 10; hz = Math.floor(hz / 10); const hi = hz % 10; hz = Math.floor(hz / 10); out.push((hi << 4) | lo); }
  return out;
}
// IC-705 のモード番号 → ログのモード
const RIG_MODE = { 0x00: 'SSB', 0x01: 'SSB', 0x02: 'AM', 0x03: 'CW', 0x04: 'RTTY', 0x05: 'FM', 0x06: 'FM', 0x07: 'CW', 0x08: 'RTTY', 0x17: 'DSTAR' };

class FrameParser {
  constructor(onFrame) { this.buf = []; this.onFrame = onFrame; }
  push(bytes) {
    for (const b of bytes) {
      this.buf.push(b);
      if (b === 0xFD) { const i = this.buf.indexOf(0xFE); if (i >= 0) this.onFrame(this.buf.slice(i)); this.buf = []; }
      if (this.buf.length > 256) this.buf = [];
    }
  }
}

class BleLink {
  async open(onBytes, onClose) {
    if (!navigator.bluetooth) throw new Error('このブラウザーは Bluetooth を使えません（Android・パソコンの Chrome で開いてください）。');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }, { name: 'ICOM BT(IC-705)' }],
      optionalServices: [SERVICE_UUID],
    });
    this.device.addEventListener('gattserverdisconnected', onClose);
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.ch = await service.getCharacteristic(CHAR_UUID);
    this.ch.addEventListener('characteristicvaluechanged', (ev) => {
      const v = ev.target.value;
      onBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    });
    await this.ch.startNotifications();
    // 送り方の候補（ic705-bt と同じ）。通った方法を使い続ける
    const p = this.ch.properties;
    this.modes = [];
    if (p.writeWithoutResponse) this.modes.push({ resp: false, chunk: 0 }, { resp: false, chunk: 20 });
    if (p.write || !this.modes.length) this.modes.push({ resp: true, chunk: 0 }, { resp: true, chunk: 20 });
    this.mode = 0;
  }
  async write(bytes) {
    const data = new Uint8Array(bytes);
    while (this.mode < this.modes.length) {
      const m = this.modes[this.mode];
      try {
        const parts = [];
        if (m.chunk) for (let i = 0; i < data.length; i += m.chunk) parts.push(data.slice(i, i + m.chunk));
        else parts.push(data);
        for (const part of parts) {
          if (m.resp) await this.ch.writeValueWithResponse(part);
          else await this.ch.writeValueWithoutResponse(part);
          if (parts.length > 1) await sleep(20);
        }
        return;
      } catch (e) {
        if (!this.device.gatt.connected) throw e;
        this.mode++;
        await sleep(50);
      }
    }
    throw new Error('無線機に送れませんでした。');
  }
  close() { try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* 無視 */ } }
}

// デモ用の偽の IC-705（本物が無くても試せる）。ときどきダイヤルを回したことにする
class DemoLink {
  async open(onBytes, onClose) {
    this.onBytes = onBytes; this.onClose = onClose; this.hz = 7_015_000; this.mode = 0x03;
    this.timer = setInterval(() => {
      this.hz += (Math.random() < 0.5 ? -1 : 1) * 500;
      this.reply([0xFE, 0xFE, 0x00, RADIO_ADDR, 0x00, ...hzToBcd(this.hz), 0xFD]);
    }, 4000);
  }
  reply(arr) { setTimeout(() => this.onBytes(new Uint8Array(arr)), 40); }
  async write(b) {
    if (b[0] === 0xFE && b[1] === 0xF1) {
      if (b[3] === 0x63) { this.reply([0xFE, 0xF1, 0x00, 0x63, 0x00, 0xFD]); this.reply([0xFE, 0xF1, 0x00, 0x64, 0xFD]); }
    } else if (b[4] === 0x03) {
      this.reply([0xFE, 0xFE, CTRL_ADDR, RADIO_ADDR, 0x03, ...hzToBcd(this.hz), 0xFD]);
    } else if (b[4] === 0x04) {
      this.reply([0xFE, 0xFE, CTRL_ADDR, RADIO_ADDR, 0x04, this.mode, 0x01, 0xFD]);
    }
  }
  close() { clearInterval(this.timer); setTimeout(() => this.onClose(), 0); }
}

let link = null, granted = false, pollTimer = null, rigHz = 0, rigMode = '', isDemo = false;
let sendChain = Promise.resolve();
function send(bytes) {
  const job = sendChain.then(async () => { if (link) await link.write(bytes); });
  sendChain = job.catch(() => {});
  return job;
}
const civ = (...body) => [0xFE, 0xFE, RADIO_ADDR, CTRL_ADDR, ...body, 0xFD];

function showRig() {
  const el = $('rigState');
  if (!link) { el.classList.remove('on'); $('connBtn').textContent = 'IC-705 につなぐ'; $('demoBtn').hidden = false; return; }
  el.classList.add('on');
  el.textContent = `${isDemo ? 'デモ' : 'IC-705'}: ${rigHz ? mhzStr(rigHz / 1e6) + ' MHz' : '読み取り中…'} ${rigMode}`;
  $('connBtn').textContent = '切る';
  $('demoBtn').hidden = true;
}
// 無線機の値を入力欄へ（その欄を触っている最中は上書きしない）
function applyRig() {
  if (rigHz && document.activeElement !== $('freq')) {
    const f = mhzStr(rigHz / 1e6);
    if ($('freq').value !== f) { $('freq').value = f; onFreqChanged(); rememberForm(); }
  }
  if (rigMode && document.activeElement !== $('mode')) {
    const cur = $('mode').value;
    // SSB の無線機で FT8・FT4 を選んでいるときは、そのままにする（データモードは読んでいない）
    const keep = rigMode === 'SSB' && (cur === 'FT8' || cur === 'FT4');
    if (!keep && cur !== rigMode) { $('mode').value = rigMode; setDefaultRst(); updateDupe(); rememberForm(); }
  }
}
const parser = new FrameParser((f) => {
  if (f[1] === 0xF1) { if (f[3] === 0x64) granted = true; return; }
  if (f[1] !== 0xFE || f[3] !== RADIO_ADDR) return;
  const cmd = f[4];
  if ((cmd === 0x03 || cmd === 0x00) && f.length >= 11) {
    rigHz = bcdToHz(f.slice(5, 10));
  } else if ((cmd === 0x04 || cmd === 0x01) && f.length >= 7) {
    rigMode = RIG_MODE[f[5]] || rigMode;
  } else return;
  showRig();
  applyRig();
});

async function connect(demo) {
  if (link) { disconnect(); return; }
  isDemo = demo;
  granted = false; rigHz = 0; rigMode = ''; parser.buf = [];
  const l = demo ? new DemoLink() : new BleLink();
  $('rigState').textContent = demo ? 'デモにつないでいます…' : 'IC-705 を選んでください…';
  try {
    await l.open((bytes) => parser.push(bytes), () => onClosed(l));
    link = l;
    showRig();
    // あいさつ（ic705-bt と同じ）。はじめての端末は、本体を「相手の機器からペアリング」にしておく
    await send([0xFE, 0xF1, 0x00, 0x61, ...ascii(clientId()), 0xFD]);
    await sleep(50);
    await send([0xFE, 0xF1, 0x00, 0x62, ...ascii(APP_NAME.padEnd(16, ' ').slice(0, 16)), 0xFD]);
    await sleep(50);
    await send([0xFE, 0xF1, 0x00, 0x63, 0xEE, 0x39, 0x09, 0x10, 0xFD]);
    for (let i = 0; i < 30 && !granted && link; i++) await sleep(100);
    if (!link) return;
    await send(civ(0x03));
    await send(civ(0x04));
    pollTimer = setInterval(poll, POLL_MS);
  } catch (e) {
    l.close();
    link = null;
    showRig();
    $('rigState').textContent = e.name === 'NotFoundError' ? 'IC-705: つないでいません' : 'つなげませんでした: ' + e.message;
  }
}
let pollBusy = false;
async function poll() {
  if (!link || pollBusy) return;
  pollBusy = true;
  try { await send(civ(0x03)); await send(civ(0x04)); } catch (e) { /* 次の回にまた読む */ }
  finally { pollBusy = false; }
}
function disconnect() {
  const l = link;
  link = null;
  clearInterval(pollTimer);
  if (l) l.close();
  showRig();
  $('rigState').textContent = 'IC-705: 切りました';
}
function onClosed(l) {
  if (link !== l) return;
  link = null;
  clearInterval(pollTimer);
  showRig();
  $('rigState').textContent = 'IC-705: 切れました（もう一度「つなぐ」を押してください）';
}
$('connBtn').addEventListener('click', () => connect(false));
$('demoBtn').addEventListener('click', () => connect(true));

// ===================== はじめ =====================
$('qsoForm').addEventListener('submit', (e) => { e.preventDefault(); logQso(); });
$('clearBtn').addEventListener('click', () => { clearEntry(); showMsg(''); $('call').focus(); });
$('call').addEventListener('input', updateDupe);
$('freq').addEventListener('input', () => { onFreqChanged(); rememberForm(); });
$('freq').addEventListener('change', () => { const f = freqNorm($('freq').value); if (f) $('freq').value = f; onFreqChanged(); rememberForm(); });
$('mode').addEventListener('change', () => { setDefaultRst(); updateDupe(); rememberForm(); });
for (const id of ['rstS', 'rstR']) $(id).addEventListener('input', () => { rstTouched = true; });

function tick() {
  const d = new Date();
  $('utcNow').textContent = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}
tick();
setInterval(tick, 1000);

loadDb();
if (db.cur && !curAct()) db.cur = null;
$('freq').value = db.form.freq || '';
$('mode').value = db.form.mode || 'CW';
setDefaultRst(true);
onFreqChanged();
render();
// はじめはいつも運用の一覧（メイン画面）
history.replaceState({ fieldlog: true, view: 'list' }, '');
showView('list');
renderActList();

// オフライン対応（電波の無い山でも開けるように、このページのファイルを端末に取っておく）
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
