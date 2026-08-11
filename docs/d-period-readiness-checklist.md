# D期即応チェックリスト

**目的**: リターンの本体は約3年に1回・2〜3ヶ月の D期（大強気相場）に集中する（`.claude/rules/backtest.md` 却下#21）。
その期間にデータ欠損・発注経路障害・SL失効などで数日止まることが、この戦略にとって最大のテールリスク。
D期の入り口でシステム全体を点検し、「来た時に確実に撃てる」状態を確認する。

**実施タイミング**: `regime-shift-notify`（強気相場モニター）が 🟢 MODERATE_BULL (4/5) 以上を通知した時。
🟡 EARLY_SIGNAL (3/5) の時点で先行実施しても良い。所要 15〜30分。

---

## 1. データ鮮度

stale データはキルスイッチ誤発火（却下#25 の 2026-06-30 事故）や breadth 判定ズレの原因になる。

- [ ] `StockDailyBar` の最新日付が直近営業日か
  ```sql
  SELECT max(date) FROM "StockDailyBar";
  ```
- [ ] `^N225` / `^VIX` の最新日付が直近営業日か（VIX欠損はサイレントに regime=normal 扱いになる）
  ```sql
  SELECT s."tickerCode", max(b.date) FROM "StockDailyBar" b
  JOIN "Stock" s ON s.id = b."stockId"
  WHERE s."tickerCode" IN ('^N225', '^VIX') GROUP BY 1;
  ```
- [ ] 朝の `market-assessment` Slack 通知で breadth / VIX / CME乖離 / 日経前日比が当日の値になっているか
  （日経の stale 警告「live と乖離 >0.5pp」が出ていないか）

## 2. 発注経路（立花API）

- [ ] 直近営業日の 15:24 entry-monitors（worker.ts）が Slack にログを出しているか
  （gapup-monitor → us-etf → panic の順。エラーで途中停止していないか）
- [ ] 立花ログインが成功しているか（買余力照会が値を返しているか）。失敗時は
  `TACHIBANA_AUTH_ID` / パスキー / API利用設定（`.claude/rules/tachibana-api.md`）を確認
- [ ] 買付可能額が想定資金と一致しているか（入金忘れ・拘束金がないか）
- [ ] 直近の約定で `[sub:11430]`（買付可能額の掛目拒否）等の受付エラーが頻発していないか
  （買余力バッファ 0.80 = KOH-580 で緩和済みだが、規制銘柄が増える D期は再発しやすい）

## 3. SL（逆指値）の生存

D期はポジションが常時埋まる。SL が板から消えた状態が最も危険。

- [ ] 保有全ポジションにブローカー側 SL 逆指値が生きているか（`CLMOrderList` の現在状態が権威。
  発注日でなく現在の注文状態で確認 — 複数日逆指値は営業日がロールする、KOH-587）
- [ ] `ensure-broker-sl` の期限更新が正常に回っているか（`sOrderExpireDay` は最大10営業日、
  期限内更新が必ず入る設計。retryCount 系の警告が出ていないか）
- [ ] panic ポジション（1321）がある場合: SL は -12% 固定・トレーリング/防御決済の対象外が正しい
  （position-monitor から除外済み。「直っていないか」を逆に確認）

## 4. インフラ

- [ ] Railway DB 使用量が上限 5GB に対して余裕があるか（2026-05-21 に容量パンクの前科あり。
  D期はバー数・シグナル・通知が全部増える）
- [ ] Railway の worker がデプロイ済み最新 commit で稼働しているか
- [ ] Slack Webhook が生きているか（このチェックリストに到達した = regime-shift 通知が来た = 生きている）
- [ ] cron-job.org のジョブが enabled か（morning-analysis / end-of-day 系）

## 5. 戦略の健全性

- [ ] 直近の Monthly Strategy Health で GU 健全性が 🟢 HEALTHY / 🟡 WATCH か
  （🟠 WARNING 以上なら D期入り前に原因を見る。PSC 復帰ゲートの判定も確認）
- [ ] 直近の Monthly live↔BT Parity Audit に系統的乖離（①日次フィルター / ②ユニバース）が出ていないか
  （SMA50 事故型。D期を乖離した設定で走るのが最悪のシナリオ）
- [ ] VIX regime が normal であること（elevated/high ならサイズ 0.5x/0.25x で正しく縮小されるかを認識）

## 6. 資金

- [ ] 買付余力が投入予定額と一致（追加入金するなら D期序盤で。¥500K では現金が制約 = 却下#40）
- [ ] 資金を増やした場合: `getMaxBuyablePrice` はユニバース上限 ¥2,500 キャップ（KOH-503）で
  ドリフトしないことを確認済み。枠 (GU3) は変更不要（¥10M+ になったら再評価 = 却下#40）

## 7. 触らないもの（D期中のパラメータ変更は禁止）

D期は単発の派手な数字が出やすく、「磨き上げ」の誘惑が最大化する期間。以下は検証済みの確定値:

- **GU trail 0.3** — 唯一「他が有意に劣る」と確定した値（却下#47、p<0.05・0/16窓）。動かさない
- **breadth band 54-80% / cooldown 3日 / maxPrice ¥2,500 / risk 2% / gap3%×vol1.5** — 16窓で維持確定（却下#42-46, #63）
- **panic のトレーリング/防御決済の除外** — 触ると辛抱型ドリフトが死ぬ（KOH-554）
- 単発BTで baseline を超える数字が出ても、WF と 16窓検定を通すまで本番に入れない（プロジェクト鉄則）

---

**このリストの更新**: 本番構成・ジョブ構成が変わったら該当項目を更新すること。
リンク元は `src/jobs/regime-shift-notify.ts`（MODERATE_BULL 以上の通知に添付）。
