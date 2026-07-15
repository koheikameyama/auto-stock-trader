/**
 * パニック底反発のシグナル判定（純粋関数・DB非依存） (KOH-554)
 *
 * BT 側の定義は `scripts/_gen-panic-events.ts`。**そちらと1:1で一致させること**。
 * ズレると「BT で検証済み」が嘘になる。
 *
 * 判定に使う値はすべて**確定済みの前営業日終値ベース**。本番 15:24 時点で当日の breadth は
 * 取得できず（全3,000銘柄のライブ時価が必要 = 立花の負荷ルール違反）、BT もこの1営業日ラグを
 * 織り込んだ定義で再検証済み（`--entry-lag 1`, KOH-554 Phase 1）。
 */

import { PANIC } from "../../lib/constants/panic";

export interface PanicSignalInput {
  /** ^VIX の前US終値。15:24 JST 時点で既知（米国市場は日中クローズ済み） */
  prevVixClose: number;
  /** breadth (0..1)。BT と同じユニバース定義で算出した前営業日終値ベースの値 */
  breadth: number;
  /** N225 の連続下落営業日数（前営業日終値まで） */
  nikkeiDownStreak: number;
  /**
   * 「前営業日の時点でも3条件が揃っていたか」。true = エピソード継続日なので発注しない。
   * BT の「エピソード初日のみ（前営業日も該当なら除外）」に対応する。
   */
  prevDayConditionsMet: boolean;
}

export interface PanicSignalParams {
  /** VIX 下限（排他: > vixMin） */
  vixMin: number;
  /** breadth 上限（排他: < breadthMax） */
  breadthMax: number;
  /** 連続下落日数の下限（>= minDownStreak） */
  minDownStreak: number;
}

export const PANIC_SIGNAL_DEFAULTS: PanicSignalParams = {
  vixMin: PANIC.VIX_MIN,
  breadthMax: PANIC.BREADTH_MAX,
  minDownStreak: PANIC.MIN_DOWN_STREAK,
};

export interface PanicSignalResult {
  /** VIX/breadth/streak の3条件が揃ったか（エピソード判定を含まない） */
  conditionsMet: boolean;
  /** エピソード初日か（= conditionsMet かつ 前営業日は非該当） */
  isEpisodeFirstDay: boolean;
  /** 実際に発注する条件 = conditionsMet && isEpisodeFirstDay */
  triggered: boolean;
  /** 不発理由（ログ/Slack/PanicSignal.skipReason 用） */
  rejectReasons: string[];
}

/**
 * パニック底反発のシグナルを判定する。
 *
 * `conditionsMet` と `triggered` を分けているのは、同じ関数を前営業日にも適用して
 * `prevDayConditionsMet` を求めるため（状態を持たずにエピソード初日を判定できる）。
 */
export function detectPanicSignal(
  input: PanicSignalInput,
  params: PanicSignalParams = PANIC_SIGNAL_DEFAULTS,
): PanicSignalResult {
  const rejectReasons: string[] = [];

  // NaN/Infinity が紛れ込んでも発火させない（データ欠損で -12% を張るのが最悪）
  if (!Number.isFinite(input.prevVixClose)) {
    rejectReasons.push("VIX が数値でない");
  } else if (!(input.prevVixClose > params.vixMin)) {
    rejectReasons.push(`VIX ${input.prevVixClose.toFixed(1)} <= ${params.vixMin}`);
  }

  if (!Number.isFinite(input.breadth)) {
    rejectReasons.push("breadth が数値でない");
  } else if (!(input.breadth < params.breadthMax)) {
    rejectReasons.push(
      `breadth ${(input.breadth * 100).toFixed(1)}% >= ${(params.breadthMax * 100).toFixed(0)}%`,
    );
  }

  if (!Number.isFinite(input.nikkeiDownStreak)) {
    rejectReasons.push("N225連続下落日数が数値でない");
  } else if (!(input.nikkeiDownStreak >= params.minDownStreak)) {
    rejectReasons.push(`N225連続下落 ${input.nikkeiDownStreak}日 < ${params.minDownStreak}日`);
  }

  const conditionsMet = rejectReasons.length === 0;
  const isEpisodeFirstDay = conditionsMet && !input.prevDayConditionsMet;

  if (conditionsMet && input.prevDayConditionsMet) {
    rejectReasons.push("エピソード継続日（前営業日も該当）");
  }

  return {
    conditionsMet,
    isEpisodeFirstDay,
    triggered: isEpisodeFirstDay,
    rejectReasons,
  };
}

/**
 * 昇順の終値列から、末尾で終わる連続下落本数を数える。
 *
 * BT (`scripts/_gen-panic-events.ts:76-82`) と同じ `cur < prev` 定義。
 * **横ばい（cur === prev）は 0 にリセット**される点に注意。
 */
export function computeNikkeiDownStreak(closes: number[]): number {
  let streak = 0;
  for (let i = 1; i < closes.length; i++) {
    streak = closes[i] < closes[i - 1] ? streak + 1 : 0;
  }
  return streak;
}
