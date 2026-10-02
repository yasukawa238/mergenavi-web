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


## v0.4.7 修正
### 室内テスト
v0.4.6では速度のみ疑似化しており、実GPS位置が合流点より先へ投影されると残距離0m → ETA 0s → KEEP固定になる問題がありました。

v0.4.7では室内テスト時にGPS/経路投影をETA計算から完全に切り離し、
以下4値から両車ETAを即時計算します。

- 本線車 Test Speed [km/h]
- 本線車 Test 残距離 [m]
- 合流車 Test Speed [km/h]
- 合流車 Test 残距離 [m]

初期値:
- 本線 617m / 50km/h = 約44.4s
- 合流 370m / 30km/h = 約44.4s
→ 許容差0.5sならKEEPが正常

例:
- 本線速度を60km/hへ変更すると本線ETAが短くなり、
  速度調整対象が本線車ならSLOW表示を確認できます。

室内テストはGPS開始不要です。
同一Sessionへ接続している場合は、テスト値をRealtimeでも共有します。

### 経路描画
スマホのtouchstart/touchend直接検出を復旧し、
スクロール抑制と経路点追加の両立を強化しました。


## v0.4.8 UI整理
- 「ログ→自車経路（SQL不要）」を明示
- 「クラウド保存（初回SQL必要）」を明示
- 経路生成処理は端末内 `driveLog` のみを使用し、Supabase DBへアクセスしない
- SQL設定が必要なのはクラウド保存機能だけ


## v0.4.9 UI再配置
- 本線車選択時: 青系テーマ
- 合流車選択時: オレンジ系テーマ
- ヘッダーに本線車/合流車の役割バッジを常時表示
- 地図・経路設定ボタンを地図の直上へ移動
- 走行ログ操作を画面最下部へ移動
- スマホ画面で役割と操作領域を直感的に識別しやすく変更


## v0.5.0 MASTER/FOLLOWER
- 本線車を MASTER として運用
- 合流車は FOLLOWER
- 共通設定は本線車からRealtime配信し、合流車側へ自動反映
- 合流車側の共通設定UIは読み取り専用

### MASTER管理する共通設定
- 合流点
- 速度調整する車両
- 判定許容差
- 室内テスト ON/OFF
- 本線車 Test Speed / Test 残距離
- 合流車 Test Speed / Test 残距離

### 各車両が個別管理するもの
- 自車経路
- GPS
- 走行ログ
- CSV / クラウド保存

### 状態同期
- FOLLOWER参加時は `requestState`
- MASTERのみが共通状態を返信
- MASTERの設定変更時は `commonSettings` Broadcastを送信


## v0.5.1
### 保存ログから経路再利用
- Supabase `drive_logs` から現在の車両種別と同じログを最新30件取得
- 日時 / 車両種別 / 点数 / Session ID を一覧表示
- 選択ログの `log_data` から経路を再生成
- Accuracy > 30m、2m未満の近接点、80m超のGPS飛びを除外
- 生成した経路を自車経路へ設定し、Realtimeで相手端末へ共有
- 経路設定後、地図表示を自動的に経路全体へフィット

### UI
- 「現在地へ」ボタンを接続設定エリアから地図・経路設定エリアへ移動


## v0.5.2
### ログ名
- 走行ログ保存時に任意名を付与
- 未入力時は `本線_YYYYMMDD_HHMM` / `合流_YYYYMMDD_HHMM` を自動生成
- 保存ログ一覧の先頭へログ名表示
- 既存DBには `supabase_upgrade_v0.5.2.sql` を一度実行

### MASTER / FOLLOWER表示
- MASTER（本線車）: 青の大型バナー
- FOLLOWER（合流車）: オレンジの大型バナー
- 画面外周も役割色で表示

### 画面ロック防止
- Screen Wake Lock APIを使用
- 「画面ロック防止 ON/OFF」ボタン追加
- ページが再表示されたとき、ON設定ならWake Lockを再取得
- 非対応ブラウザでは「非対応」と表示


## v0.5.3
### Realtime接続UI
- 接続機器一覧をRealtime接続ボタン直下へ移動
- 接続台数を表示
- 本線車は青、合流車はオレンジのチップで表示
- 自車には「自車」表示

### Session ID共有
- Session ID入力欄の横に「IDコピー」ボタン追加
- Teams等へSession IDだけをそのまま貼り付け可能
- 既存の「共有リンクコピー」も継続
