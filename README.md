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


## v0.4.2 変更点
- Device Geolocation値をそのまま使用するRaw優先モードに変更
  - 緯度/経度はブラウザGeolocationの値をそのまま利用
  - 速度は `coords.speed` をそのまま利用
  - 独自の移動距離差分からの速度算出を停止
  - 速度EMA平滑化を停止
  - `enableHighAccuracy: true`
- 室内テストモード追加
  - 本線車/合流車のテスト速度を任意指定
  - GPS位置は実測のまま、ETA計算速度だけ置換
- 地図/航空写真切替を追加
- 経路描画中は地図ドラッグを無効化
- 「地図移動」ボタンで描画中に一時的にパン可能

### GPSに関する注意
WebブラウザからスマートフォンのGNSS受信機のRaw Measurementへ直接アクセスすることはできません。
本版では `navigator.geolocation.watchPosition()` の高精度モードを使用し、
返された端末位置を別の位置APIや地図APIで補正・再計算せず、そのまま使用しています。


## v0.4.3 修正
- スマホで経路描画時にブラウザ画面自体がスクロールする問題を修正
- 経路描画モード:
  - bodyスクロール禁止
  - map上のtouchmoveをpreventDefault
  - overscroll禁止
  - touch-action:none
- 「地図移動」モードではパン操作を再許可


## v0.4.4 修正
- v0.4.3でスマホのタップがLeaflet clickに届かず、drawPointsへ点が追加されない問題を修正
- touchstart/touchendでスマホのタップを直接検出
- タップ位置を `map.containerPointToLatLng()` で地図座標へ変換
- タップごとに「経路点 n」をトースト表示
- タッチ後のsynthetic clickによる二重点追加を防止


## v0.4.5 変更
- スマホ画面上部へ `Ver 0.4.5` を常時表示
- JavaScript側にも `APP_VERSION = "0.4.5"` を追加
- 今後、不具合確認時に画面だけで使用版を判別可能


## v0.4.6 追加
- 走行ログ START / STOP
- 記録点数・記録時間表示
- CSV出力
- Supabase `drive_logs` テーブルへ走行ログ保存
- 走行ログから自車経路を自動生成
- 生成経路をRealtimeで相手端末へ共有
- Ver 0.4.6表示

### ログ内容
- timestamp / ISO時刻
- role
- 緯度 / 経度
- 端末速度
- GPS Accuracy
- Heading
- 合流点までの残距離
- ETA
- 相手車両ETA
- ΔT
- Cloud Age
- Session ID

### 初回のみ必要なSupabase設定
Supabase Dashboard → SQL Editor → New query を開き、
同梱の `supabase_setup.sql` 全文を貼り付けて Run してください。

PoCではPublishable key（anon）からログ保存できるようRLS Policyを設定します。
本運用では認証付きへ変更してください。

### ログ→経路生成
PoCの初期フィルタ:
- Accuracy > 30m は除外
- 前点から2m未満は間引き
- 前点から80m超のジャンプは除外

生成された経路は自車経路として即時適用され、同じSessionの相手端末へ共有されます。
