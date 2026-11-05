# スマレジ ダーツ取引PDF保存

取引履歴一覧（2026/09/01〜09/30）の各取引詳細を開き、商品名に「ダーツ」を含むものを
1ページPDFで `~/Downloads/smaregi_darts/` に保存します。

ファイル名: `YYYYMMDD_スマレジ売上_FINO cafe（ダーツ投げ放題）.pdf`
同日に複数ある場合は `（ダーツ投げ放題①）` `②`… を付与（取引時刻順）。

## 実行手順（Mac）
```bash
# 初回のみ（Node.js が必要: https://nodejs.org）
npm install
npx playwright install chromium

# 実行
npm start
```
1. ブラウザが開くのでスマレジにログイン（ログイン状態は `.browser-profile` に保持）
2. 取引履歴一覧が出たらターミナルで Enter
3. 自動で検索 → 全ページ巡回 → 詳細確認 → PDF保存

期間や文字列は環境変数で変更可: `FROM=2026/10/01 TO=2026/10/31 npm start`
