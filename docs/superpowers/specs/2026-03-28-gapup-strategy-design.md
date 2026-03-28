# ギャップアップ戦略 設計仕様書

## 概要

既存のブレイクアウト戦略と並行運用する**ギャップアップ（窓開け上昇）戦略**。前日終値から当日始値で大きく上にギャップした銘柄を、当日の終値で確認エントリーする短期決戦型の戦略。

### 目的

- 既存ブレイクアウト戦略が取り逃す「急騰銘柄」を捕捉
- ブレイクアウト（じわじわ上昇→新高値）とは異なるシグナルタイプで分散効果

### 戦略の特徴

| 項目 | ギャップアップ | ブレイクアウト（既存） |
|------|-------------|-------------------|
| シグナル | 前日比ギャップ＋陽線引け | 20日高値更新＋出来高サージ |
| エントリー | ギャップ当日の終値 | シグナル翌日の終値（確認足） |
| 保有期間 | 1-3日（タイムストップ3日） | 3-7日（タイムストップ7日） |
| 狙い | ギャップ後の短期モメンタム | トレンド継続 |

---

## シグナル検知 & エントリー条件

### ギャップアップシグナル（全て AND）

1. **ギャップ閾値**: `open > prevClose × (1 + gapMinPct)`
   - `gapMinPct` はバックテストで比較検証（2%, 3%, 5%）→ 固定値を決定
2. **陽線引け**: `close >= open`（ギャップが埋まっていない）
3. **終値もギャップ維持**: `close > prevClose × (1 + gapMinPct)`
4. **出来高サージ**: `volume >= avgVolume25 × volSurgeRatio`
   - `volSurgeRatio` はバックテストで比較検証（1.5x, 2.0x, 2.5x）→ 固定値を決定

### エントリー価格

当日終値（`close`）。バックテスト・本番ともに同一。

### ユニバースフィルター（既存と共通）

- `maxPrice: 5000` — 低位株
- `minAvgVolume25: 100,000` — 流動性
- `minAtrPct: 1.5%` — 最低ボラティリティ

### マーケットフィルター

- `marketTrendFilter: true` — breadth フィルター有効
- `marketTrendThreshold`: WF外で比較検証（0.5, 0.6, 0.7）→ 固定値を決定
- `indexTrendFilter: true` — N225 > SMA50

### 重複排除

エントリー時に既にその銘柄を保有中（どちらの戦略でも）ならスキップ。
同一銘柄のクールダウン: `cooldownDays: 3`（既存と同一）。

---

## エグジット（出口戦略）

### ストップロス

```
SL = entryPrice - ATR(14) × atrMultiplier
ハードキャップ: maxLossPct = 3%（entryPrice × 0.97）
実効SL = max(ATRベースSL, ハードキャップSL)
```

### トレーリングストップ

既存の `checkPositionExit()` をそのまま再利用:

- **BE（ブレイクイーブン）発動**: 含み益が `ATR × beActivationMultiplier` に達したら SL をエントリー価格に引き上げ
- **TS（トレーリング）発動**: 含み益が `ATR × tsActivationMultiplier` に達したらトレール開始
- **トレール幅**: 高値から `ATR × trailMultiplier` 下にストップを追従

### タイムストップ

- `maxHoldingDays: 3` — 短期決戦
- `maxExtendedHoldingDays: 5` — TS が効いている場合のみ延長

### VIX レジーム

既存と同一ロジック:
- Crisis（VIX > 30）: 新規エントリー停止、既存ポジション即撤退
- Elevated（VIX 20-30）: ポジションサイズ縮小

---

## WF（Walk-Forward）検証

### エントリー系パラメータ（WF外、比較テスト）

WFグリッドには入れず、単体バックテストで比較→固定値を決定:

| パラメータ | 候補値 |
|-----------|--------|
| gapMinPct | 0.02, 0.03, 0.05 |
| volSurgeRatio | 1.5, 2.0, 2.5 |
| marketTrendThreshold | 0.5, 0.6, 0.7 |

### エグジット系パラメータ（WFグリッド、81通り）

| パラメータ | 値 |
|-----------|-----|
| atrMultiplier | 0.8, 1.0, 1.2 |
| beActivationMultiplier | 0.3, 0.5, 0.8 |
| trailMultiplier | 0.3, 0.5, 0.8 |
| tsActivationMultiplier | 0.5, 1.0, 1.5 |

`tsActivationMultiplier` はブレイクアウト（1.0, 1.5, 2.0）より低め（0.5, 1.0, 1.5）。短期保有なので早期TS発動を探索。

### ウィンドウ構成

既存と同一:
- IS: 6ヶ月 / OOS: 3ヶ月 / スライド: 3ヶ月 × 6ウィンドウ = 24ヶ月

### IS最低PFゲート

IS最適PF < 0.5 のウィンドウはOOS休止（既存と同一ロジック）。

### 堅牢性判定基準

既存と同一:
| 判定 | 条件 |
|------|------|
| 堅牢 | OOS PF >= 1.3 かつ IS/OOS比 <= 2.0 |
| 要注意 | OOS PF >= 1.0 かつ IS/OOS比 <= 3.0 |
| 過学習 | OOS PF < 1.0 または IS/OOS比 > 3.0 |

---

## アーキテクチャ & ファイル構成

### 新規ファイル

```
src/backtest/
├── gapup-config.ts            # デフォルト設定 + WFパラメータグリッド
├── gapup-simulation.ts        # シミュレーションエンジン

src/core/gapup/
├── entry-conditions.ts        # isGapUpSignal() 純粋関数

src/lib/constants/
├── gapup.ts                   # ギャップ戦略の定数

scripts/
├── walk-forward-gapup.ts      # WF検証スクリプト
```

### 既存コードの再利用

| コンポーネント | ファイル | 再利用方式 |
|---|---|---|
| データ取得 | `data-fetcher.ts` | そのまま使用 |
| メトリクス計算 | `metrics.ts` | そのまま使用 |
| ポジションエグジット | `checkPositionExit()` | そのまま使用 |
| シミュレーション基盤データ | `precomputeSimData()` | そのまま使用 |
| ユニバースフィルター | `passesUniverseGates()` | そのまま使用 |
| 型定義 | `types.ts` | `GapUpBacktestConfig` を新規追加 |

### precomputeパターン

```typescript
interface PrecomputedGapUpSignal {
  ticker: string;
  entryPrice: number;       // 当日終値
  gapPct: number;            // (open - prevClose) / prevClose
  atr14: number;
  volumeSurgeRatio: number;
}

function precomputeGapUpDailySignals(
  config: Pick<GapUpBacktestConfig, ...>,
  allData: Map<string, OHLCVData[]>,
  precomputed: PrecomputedSimData,
): Map<string, PrecomputedGapUpSignal[]>
```

WFグリッド81通りでエグジットパラメータのみ変化するため、シグナル検知は1ウィンドウあたり1回で済む。

### シミュレーションエンジン

`runGapUpBacktest()` — `runBreakoutBacktest()` と同じメインループ構造:

```typescript
for (dayIdx of tradingDays) {
  // 1. 既存ポジションのエグジット判定（共通 checkPositionExit）
  // 2. ギャップシグナル検知（precomputedから取得）
  // 3. シグナルソート（gapPct × volumeSurgeRatio でスコアリング）
  // 4. ポジション枠チェック（maxPositions）
  // 5. エントリー執行（リスクベースポジションサイジング）
  // 6. エクイティ更新
}
```

### ポジション管理（バックテスト vs 本番）

- **バックテスト**: 各戦略を独立に実行。maxPositions は各戦略で個別設定
  - ブレイクアウト: maxPositions = 3
  - ギャップアップ: maxPositions = 2
- **本番運用**: entry-executor レベルで全戦略合算のポジション枠（5）を管理

理由: バックテストで両戦略を同時シミュレーションするとシグナル優先順位付けが必要になり複雑度が爆発する。まず各戦略の単独エッジを検証する。

---

## CLIコマンド

### 単体バックテスト

```bash
npm run backtest:gapup
# オプション: --start 2025-01-01 --end 2025-12-31 --budget 500000 --verbose
```

### Walk-Forward 検証

```bash
npm run walk-forward:gapup
```

### エントリーパラメータ比較

```bash
npm run backtest:gapup -- --compare-entry
# gapMinPct × volSurgeRatio × marketTrendThreshold の組み合わせを一括比較
```

---

## 成功基準

1. WF検証で OOS PF >= 1.3（堅牢判定）
2. ブレイクアウト戦略とのシグナル重複率 < 30%（分散効果の確認）
3. 各OOSウィンドウで10トレード以上（統計的有意性）
