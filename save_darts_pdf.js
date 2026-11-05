// スマレジ取引履歴一覧 → 商品名に「ダーツ」を含む取引詳細を1ページPDFで保存
// 使い方: README.md 参照
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');
const readline = require('readline');

const { execFileSync } = require('child_process');

// ===== 設定 =====
const AUTO = process.env.AUTO === '1'; // 自動実行モード（Enter待ちなし・前月を処理・Googleドライブへ保存）
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
function prevMonthRange() {
  const now = new Date();
  return [fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1)), fmt(new Date(now.getFullYear(), now.getMonth(), 0))];
}
const [PREV_FROM, PREV_TO] = prevMonthRange();
const FROM = process.env.FROM || (AUTO ? PREV_FROM : '2026/09/01');
const TO = process.env.TO || (AUTO ? PREV_TO : '2026/09/30');
const KEYWORD = process.env.KEYWORD || 'ダーツ';
const LIST_URL = 'https://www1.smaregi.jp/control/transaction/';
const OUT_DIR = process.env.OUT_DIR || path.join(os.homedir(), 'Downloads', 'smaregi_darts');
const PROFILE_DIR = path.join(__dirname, '.browser-profile'); // ログイン状態を保持
// Googleドライブ（Google Drive for desktop）内の保存先。この下に「年/年月」フォルダを作って入れる
const DRIVE_SUBPATH = ['共有ドライブ', 'ナスダック上場関連資料まとめ (Nasdaq)', 'Quickbook', 'cash book', 'sales cash (現金売上)', 'POSスマレジ', 'プラフィーノカフェ'];
const SAVE_TO_DRIVE = AUTO || process.env.DRIVE === '1';
// ================

// 文字の表記ゆれ（濁点の形・全角半角・空白）を無視して比較する
const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '');
function findChild(dir, name) {
  try {
    return fs.readdirSync(dir).find((n) => norm(n) === norm(name));
  } catch (e) {
    return undefined;
  }
}
function resolveDriveRoot() {
  const base = path.join(os.homedir(), 'Library', 'CloudStorage');
  let accounts = [];
  try { accounts = fs.readdirSync(base).filter((n) => n.startsWith('GoogleDrive-')); } catch (e) {}
  for (const acc of accounts) {
    let cur = path.join(base, acc);
    let ok = true;
    for (const seg of DRIVE_SUBPATH) {
      const hit = findChild(cur, seg);
      if (!hit) { ok = false; break; }
      cur = path.join(cur, hit);
    }
    if (ok) return cur;
  }
  return null;
}
function driveDest(root, date) {
  let cur = root;
  for (const seg of [date.slice(0, 4), date.slice(0, 6)]) {
    const hit = findChild(cur, seg);
    cur = path.join(cur, hit || seg);
    fs.mkdirSync(cur, { recursive: true });
  }
  return cur;
}
function notify(msg) {
  try {
    execFileSync('osascript', ['-e', `display notification "${msg.replace(/"/g, '')}" with title "スマレジ ダーツPDF"`]);
  } catch (e) {}
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'.split('');
const circled = (n) => CIRCLED[n - 1] || `(${n})`;
const ask = (q) =>
  new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, () => { rl.close(); res(); });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setDatesAndSearch(page) {
  // 日付入力欄（YYYY/MM/DD 形式の値を持つ最初の2つ）
  const inputs = page.locator('input[type="text"]');
  const n = await inputs.count();
  const dateInputs = [];
  for (let i = 0; i < n && dateInputs.length < 2; i++) {
    const v = await inputs.nth(i).inputValue().catch(() => '');
    if (/^\d{4}\/\d{2}\/\d{2}$/.test(v)) dateInputs.push(inputs.nth(i));
  }
  if (dateInputs.length < 2) throw new Error('取引日時の入力欄が見つかりません');
  for (const [el, val] of [[dateInputs[0], FROM], [dateInputs[1], TO]]) {
    await el.fill(val);
    await el.press('Escape').catch(() => {});
  }
  await page.getByRole('button', { name: '検索' }).first().click();
  await page.waitForLoadState('networkidle');
  await sleep(1000);
}

// 現在の一覧ページから取引 { id, href, date, time } を取得
async function collectRows(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('table tbody tr').forEach((tr) => {
      const a = [...tr.querySelectorAll('a')].find((x) => /^\d{3,}$/.test(x.textContent.trim()));
      if (!a) return;
      const text = tr.innerText;
      const m = text.match(/(\d{4})\/(\d{2})\/(\d{2})\s*(\d{2}:\d{2}:\d{2})?/);
      out.push({
        id: a.textContent.trim(),
        href: a.href,
        date: m ? m[1] + m[2] + m[3] : null,
        time: m && m[4] ? m[4] : '',
      });
    });
    return out;
  });
}

async function collectAll(page) {
  const all = new Map();
  for (let p = 1; p < 500; p++) {
    const rows = await collectRows(page);
    rows.forEach((r) => all.set(r.id, r));
    console.log(`一覧 ${p}ページ目: ${rows.length}件 (累計 ${all.size}件)`);
    const next = page.locator('a:has-text("次へ"), li:has-text("次へ") a, button:has-text("次へ")').first();
    if (!(await next.count()) || !(await next.isVisible()) || (await next.isDisabled().catch(() => false))) break;
    const cls = (await next.getAttribute('class').catch(() => '')) || '';
    if (/disabled/.test(cls)) break;
    const firstId = rows[0] && rows[0].id;
    await next.click();
    await page.waitForLoadState('networkidle');
    // 先頭IDが変わるまで待つ
    for (let i = 0; i < 30; i++) {
      const cur = await collectRows(page);
      if (cur[0] && cur[0].id !== firstId) break;
      await sleep(500);
    }
  }
  return [...all.values()];
}

async function savePdf(page, file) {
  await page.emulateMedia({ media: 'screen' });
  const { w, h } = await page.evaluate(() => ({
    w: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)),
    h: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)) + 4,
  }));
  // 1ページに収める（Chromiumの上限 200inch ≒ 19200px）
  await page.pdf({
    path: file,
    width: `${w}px`,
    height: `${Math.min(h, 19000)}px`,
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
    pageRanges: '1',
  });
}

function installSchedule() {
  const label = 'com.smaregi.darts';
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const log = path.join(os.homedir(), 'Library', 'Logs', 'smaregi_darts.log');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${__filename}</string></array>
<key>WorkingDirectory</key><string>${__dirname}</string>
<key>EnvironmentVariables</key><dict><key>AUTO</key><string>1</string></dict>
<key>StartCalendarInterval</key><dict><key>Day</key><integer>1</integer><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`);
  const uid = String(process.getuid());
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch (e) {}
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist]);
  console.log('登録しました: 毎月1日 12:00 に前月分を自動実行します。');
  console.log('ログ:', log);
  console.log('今すぐ試すには:  launchctl kickstart gui/' + uid + '/' + label);
}

if (process.argv.includes('--install-schedule')) {
  installSchedule();
  process.exit(0);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: AUTO && process.env.HEADED !== '1',
    viewport: { width: 1400, height: 1000 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(LIST_URL);
  if (!AUTO) {
    console.log('\nブラウザでスマレジにログインし、「取引履歴一覧」が表示された状態にしてください。');
    await ask('表示できたら Enter を押してください > ');
    if (!page.url().includes('/control/transaction')) await page.goto(LIST_URL);
  } else {
    console.log(`\n[${new Date().toLocaleString('ja-JP')}] 自動実行: ${FROM} 〜 ${TO}`);
    await page.waitForLoadState('networkidle');
    if (!page.url().includes('/control/transaction')) {
      throw new Error('スマレジのログインが切れています。手動で npm start を実行してログインし直してください。');
    }
  }
  let driveRoot = null;
  if (SAVE_TO_DRIVE) {
    driveRoot = resolveDriveRoot();
    if (!driveRoot) throw new Error('Googleドライブの保存先フォルダが見つかりません（Google Drive for desktop が起動していますか？）');
    console.log('Googleドライブ保存先:', driveRoot);
  }

  await setDatesAndSearch(page);
  const rows = await collectAll(page);
  console.log(`\n対象期間の取引: ${rows.length}件。詳細を確認します…`);

  const hits = [];
  const detail = await ctx.newPage();
  for (const [i, r] of rows.entries()) {
    try {
      await detail.goto(r.href, { waitUntil: 'networkidle' });
      const text = await detail.evaluate(() => document.body.innerText);
      const line = text.split('\n').find((l) => l.includes(KEYWORD));
      if (line) {
        const tmp = path.join(OUT_DIR, `_tmp_${r.id}.pdf`);
        await savePdf(detail, tmp);
        hits.push({ ...r, tmp });
        console.log(`[${i + 1}/${rows.length}] ${r.id} ${r.date} ○ ${line.trim().slice(0, 40)}`);
      } else {
        console.log(`[${i + 1}/${rows.length}] ${r.id} ${r.date} -`);
      }
    } catch (e) {
      console.log(`[${i + 1}/${rows.length}] ${r.id} エラー: ${e.message}`);
    }
  }
  await ctx.close();

  // 日付ごとにまとめてリネーム（同日複数なら ①②…）
  const byDate = {};
  hits.forEach((h) => (byDate[h.date || 'unknown'] ||= []).push(h));
  for (const [date, list] of Object.entries(byDate)) {
    list.sort((a, b) => (a.time + a.id).localeCompare(b.time + b.id));
    list.forEach((h, idx) => {
      const suffix = list.length > 1 ? circled(idx + 1) : '';
      const name = `${date}_スマレジ売上_FINO cafe（ダーツ投げ放題${suffix}）.pdf`;
      fs.renameSync(h.tmp, path.join(OUT_DIR, name));
      console.log('保存:', name);
      if (driveRoot && h.date) {
        const dest = driveDest(driveRoot, h.date);
        fs.copyFileSync(path.join(OUT_DIR, name), path.join(dest, name));
        console.log('  → Googleドライブ:', path.basename(dest));
      }
    });
  }
  console.log(`\n完了: ${hits.length}件 → ${OUT_DIR}`);
  if (AUTO) notify(`${FROM}〜${TO}: ${hits.length}件を保存しました`);
})().catch((e) => {
  console.error(e);
  if (AUTO) notify('失敗しました: ' + e.message.slice(0, 80));
  process.exit(1);
});
