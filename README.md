# MergeNavi Cloud Supabase v0.4

## 構成
本線車スマホ ─ 4G/5G ─ Supabase Realtime ─ 4G/5G ─ 合流車スマホ

- PC常駐サーバー不要
- 同一Wi-Fi不要
- Node.js不要
- DBテーブル不要
- SQL不要

## 使っているSupabase機能
- Realtime Broadcast: GPS / ETA / 合流点 / ルート共有
- Presence: 接続中の車両確認

Publishable keyのみ使用しています。Secret keyは含めていません。

## GitHub Pages公開
1. GitHubで新規Repositoryを作成（例: mergenavi-web）
2. 以下4ファイルをRepository直下へアップロード
   - index.html
   - style.css
   - app.js
   - supabase-config.js
3. Settings → Pages
4. Deploy from a branch
5. Branch: main / Folder: /(root)
6. Save
7. 数分後のHTTPS URLをスマホで開く

## 2台テスト
1. 1台目でURLを開く
2. Session ID生成 → Realtime接続
3. 共有リンクコピー
4. 2台目で共有リンクを開く
5. 車両を本線車 / 合流車に分ける
6. 両方でRealtime接続
7. 「接続端末」に2台表示されるか確認
8. 合流点と各車両ルートを設定
9. GPS開始

## v0.4の制約
Broadcast方式なので設定はDBへ永続保存しません。
両端末が閉じると設定は消えます。PoC用として意図した仕様です。


## v0.4.1 修正
- Leaflet JavaScriptの読み込み漏れを修正。
- v0.4では `L is not defined` により app.js が停止し、Realtime接続ボタン等が動作しない不具合がありました。
