import { describe, it, expect } from "vitest";
import {
  checkPositionExit,
  type PositionForExit,
  type BarForExit,
} from "../exit-checker";

// --- helpers ---

function makePosition(overrides: Partial<PositionForExit> = {}): PositionForExit {
  return {
    entryPrice: 2000,
    takeProfitPrice: 2200,
    stopLossPrice: 1920,      // entry - ATR*1.0
    entryAtr: 80,
    maxHighDuringHold: 2000,
    minLowDuringHold: 2000,
    currentTrailingStop: null,
    strategy: "breakout",
    holdingBusinessDays: 1,
    ...overrides,
  };
}

function makeBar(overrides: Partial<BarForExit> = {}): BarForExit {
  return {
    open: 2010,
    high: 2020,
    low: 2000,
    close: 2010,
    ...overrides,
  };
}

// --- tests ---

describe("checkPositionExit", () => {
  // ============================================================
  // 利確（take_profit）
  // ============================================================
  describe("利確", () => {
    it("bar.high >= TP → exitPrice = TP", () => {
      // TP=2050（BE閾値=2080より低い）→ トレーリング未発動のままTP到達
      const result = checkPositionExit(
        makePosition({ takeProfitPrice: 2050 }),
        makeBar({ open: 2040, high: 2060, low: 2030, close: 2055 }),
      );
      expect(result.exitPrice).toBe(2050);
      expect(result.exitReason).toBe("take_profit");
    });

    it("ギャップアップ: bar.open > TP → exitPrice = bar.open", () => {
      // TP=2050, bar.open=2060 > TP → 有利約定
      const result = checkPositionExit(
        makePosition({ takeProfitPrice: 2050 }),
        makeBar({ open: 2060, high: 2070, low: 2055, close: 2065 }),
      );
      expect(result.exitPrice).toBe(2060);
      expect(result.exitReason).toBe("take_profit");
    });

    it("bar.highがBE閾値以上 → トレーリング発動でTP無効化される", () => {
      // TP=2200だがbar.high=2210 → newMaxHigh=2210 >= BE(2080) → trailing発動
      // effectiveTP=null → TP判定スキップ
      const result = checkPositionExit(
        makePosition(),
        makeBar({ open: 2180, high: 2210, low: 2170, close: 2200 }),
      );
      expect(result.isTrailingActivated).toBe(true);
      expect(result.exitReason).toBeNull(); // TP無効化、SLにも当たらず
    });
  });

  // ============================================================
  // 損切り（stop_loss）
  // ============================================================
  describe("損切り", () => {
    it("bar.low <= SL → exitPrice = SL", () => {
      const result = checkPositionExit(
        makePosition(),
        makeBar({ open: 1950, high: 1960, low: 1910, close: 1930 }),
      );
      expect(result.exitPrice).toBe(1920);
      expect(result.exitReason).toBe("stop_loss");
    });

    it("ギャップダウン: bar.open < SL → exitPrice = bar.open（スリッページ）", () => {
      const result = checkPositionExit(
        makePosition(),
        makeBar({ open: 1900, high: 1910, low: 1890, close: 1895 }),
      );
      expect(result.exitPrice).toBe(1900);
      expect(result.exitReason).toBe("stop_loss");
    });
  });

  // ============================================================
  // SLがTPより優先
  // ============================================================
  describe("SL > TP 優先", () => {
    it("TP到達かつSL到達（トレーリング未発動）→ stop_lossが上書き", () => {
      // TP=2050（BE閾値=2080より低い）→ トレーリング未発動
      // high=2060 >= TP(2050) かつ low=1910 <= SL(1920) → SLが優先
      const result = checkPositionExit(
        makePosition({ takeProfitPrice: 2050 }),
        makeBar({ open: 2000, high: 2060, low: 1910, close: 1950 }),
      );
      expect(result.exitReason).toBe("stop_loss");
      expect(result.exitPrice).toBe(1920);
    });

    it("大レンジでhighがBE閾値超え → trailing_profitになる", () => {
      // high=2210 → trailing発動 → SL=trailingStop(2210-120=2090)
      // low=1910 <= 2090 → 約定=2090（建値2000超え）→ trailing_profit
      const result = checkPositionExit(
        makePosition(),
        makeBar({ open: 2100, high: 2210, low: 1910, close: 1950 }),
      );
      expect(result.exitReason).toBe("trailing_profit");
      expect(result.exitPrice).toBe(2090); // trailing stop（建値超え）
      expect(result.isTrailingActivated).toBe(true);
    });
  });

  // ============================================================
  // トレーリング利確（trailing_profit）
  // ============================================================
  describe("トレーリング利確", () => {
    it("トレーリング発動中 + bar.low <= trailingStop → trailing_profit", () => {
      // maxHigh=2200 → BE=2080(breakout, ATR=80, mult=1.0) → 発動
      // trailingStop = 2200 - 120 = 2080（trail=1.5 ATR）
      const result = checkPositionExit(
        makePosition({ maxHighDuringHold: 2200 }),
        makeBar({ open: 2090, high: 2100, low: 2070, close: 2075 }),
      );
      expect(result.exitReason).toBe("trailing_profit");
      expect(result.exitPrice).toBe(2080); // trailing stop price
      expect(result.isTrailingActivated).toBe(true);
    });

    it("トレーリング発動中 → TP判定スキップ（effectiveTP=null）", () => {
      // maxHigh=2200 → 発動。bar.highがoriginal TPに届いてもTP判定されない
      const result = checkPositionExit(
        makePosition({ maxHighDuringHold: 2200, takeProfitPrice: 2150 }),
        makeBar({ open: 2160, high: 2170, low: 2130, close: 2150 }),
      );
      // TP(2150)にbar.highが到達しているが、トレーリング発動中なのでTP判定されない
      expect(result.exitReason).toBeNull(); // トレーリングストップ(2080)にも当たらない
    });

    it("ギャップダウンでトレーリングストップを下抜け → bar.openで約定", () => {
      // trailingStop = 2200 - 120 = 2080（trail=1.5 ATR）
      const result = checkPositionExit(
        makePosition({ maxHighDuringHold: 2200 }),
        makeBar({ open: 2060, high: 2070, low: 2050, close: 2055 }),
      );
      expect(result.exitReason).toBe("trailing_profit");
      expect(result.exitPrice).toBe(2060); // bar.open（スリッページ）
    });

    it("発動中でも建値以下で約定 → trailing_stop（利確ではなく建値撤退）", () => {
      // maxHigh=2200 で発動（trailingStop=2080）。ギャップダウンで bar.low<=2080 → 決済。
      // bar.open=1990 < 2080 なので約定=1990（建値2000以下）→ 利確ではなく trailing_stop。
      const result = checkPositionExit(
        makePosition({ maxHighDuringHold: 2200 }),
        makeBar({ open: 1990, high: 1995, low: 1980, close: 1985 }),
      );
      expect(result.exitReason).toBe("trailing_stop");
      expect(result.exitPrice).toBe(1990); // bar.open（建値割れギャップ）
      expect(result.exitPrice).toBeLessThanOrEqual(2000); // <= entryPrice
      expect(result.isTrailingActivated).toBe(true);
    });

    it("発動中に建値ちょうどで約定 → trailing_stop", () => {
      // bar.open=2000（=entryPrice）で約定。exitPrice が建値超えでないので trailing_stop。
      const result = checkPositionExit(
        makePosition({ maxHighDuringHold: 2200 }),
        makeBar({ open: 2000, high: 2005, low: 1990, close: 1995 }),
      );
      expect(result.exitReason).toBe("trailing_stop");
      expect(result.exitPrice).toBe(2000); // = entryPrice
    });
  });

  // ============================================================
  // タイムストップ（time_stop）
  // ============================================================
  describe("タイムストップ", () => {
    it("ハードキャップ（10日）到達 → time_stop", () => {
      const result = checkPositionExit(
        makePosition({ holdingBusinessDays: 10 }),
        makeBar({ close: 2050 }),
      );
      expect(result.exitReason).toBe("time_stop");
      expect(result.exitPrice).toBe(2050); // bar.close
    });

    it("ベースリミット（5日）+ 含み損 → time_stop", () => {
      const result = checkPositionExit(
        makePosition({ holdingBusinessDays: 5 }),
        makeBar({ open: 1990, high: 1995, low: 1980, close: 1990 }), // close < entry
      );
      expect(result.exitReason).toBe("time_stop");
      expect(result.exitPrice).toBe(1990);
    });

    it("ベースリミット（5日）+ 含み益 → 延長（exitなし）", () => {
      const result = checkPositionExit(
        makePosition({ holdingBusinessDays: 5 }),
        makeBar({ open: 2050, high: 2060, low: 2040, close: 2050 }), // close > entry
      );
      expect(result.exitReason).toBeNull();
      expect(result.exitPrice).toBeNull();
    });

    it("トレーリング発動中 → タイムストップ適用なし", () => {
      const result = checkPositionExit(
        makePosition({ maxHighDuringHold: 2200, holdingBusinessDays: 12 }),
        makeBar({ open: 2130, high: 2140, low: 2125, close: 2130 }),
      );
      // trailing activated, bar.low > trailingStop(2080) → exitなし
      expect(result.exitReason).toBeNull();
      expect(result.isTrailingActivated).toBe(true);
    });
  });

  // ============================================================
  // gapup戦略のオーバーライド
  // ============================================================
  describe("gapup戦略（オーバーライド日数）", () => {
    it("maxHoldingDaysOverride=5 → 5日でハードキャップ", () => {
      const result = checkPositionExit(
        makePosition({
          strategy: "gapup",
          holdingBusinessDays: 5,
          maxHoldingDaysOverride: 5,
          baseLimitHoldingDaysOverride: 3,
        }),
        makeBar({ close: 2050 }),
      );
      expect(result.exitReason).toBe("time_stop");
    });

    it("baseLimitHoldingDaysOverride=3 + 含み損 → 3日で早期カット", () => {
      const result = checkPositionExit(
        makePosition({
          strategy: "gapup",
          holdingBusinessDays: 3,
          maxHoldingDaysOverride: 5,
          baseLimitHoldingDaysOverride: 3,
        }),
        makeBar({ open: 1990, high: 1995, low: 1980, close: 1990 }),
      );
      expect(result.exitReason).toBe("time_stop");
    });
  });

  // ============================================================
  // maxHigh更新
  // ============================================================
  describe("maxHigh更新", () => {
    it("bar.high > maxHighDuringHold → newMaxHighが更新される", () => {
      const result = checkPositionExit(
        makePosition({ maxHighDuringHold: 2010 }),
        makeBar({ high: 2050 }),
      );
      expect(result.newMaxHigh).toBe(2050);
    });

    it("bar.high < maxHighDuringHold → 既存値を維持", () => {
      const result = checkPositionExit(
        makePosition({ maxHighDuringHold: 2100 }),
        makeBar({ high: 2050 }),
      );
      expect(result.newMaxHigh).toBe(2100);
    });
  });

  // ============================================================
  // exit なし（通常保有継続）
  // ============================================================
  describe("exitなし", () => {
    it("TP/SL/タイムストップいずれにも該当しない → null", () => {
      const result = checkPositionExit(
        makePosition({ holdingBusinessDays: 2 }),
        makeBar({ open: 2010, high: 2030, low: 2000, close: 2020 }),
      );
      expect(result.exitPrice).toBeNull();
      expect(result.exitReason).toBeNull();
    });
  });

  // ============================================================
  // 9319.Tシナリオ再現
  // ============================================================
  describe("9319.Tシナリオ", () => {
    it("entry=2148, ATR null, breakout: 高値2232→トレーリング2187→決済", () => {
      // 1日目: 高値2232まで上昇（トレーリング発動、ストップ2187）
      const result = checkPositionExit(
        {
          entryPrice: 2148,
          takeProfitPrice: 2300,
          stopLossPrice: 2084,
          entryAtr: null,
          maxHighDuringHold: 2148, // 直前まで
          minLowDuringHold: 2148,
          currentTrailingStop: null,
          strategy: "breakout",
          holdingBusinessDays: 1,
        },
        { open: 2153, high: 2232, low: 2132, close: 2155 },
      );

      // トレーリング発動（BE = 2148*1.02 = 2190.96, maxHigh 2232 >= 2190.96）
      expect(result.isTrailingActivated).toBe(true);
      expect(result.trailingStopPrice).toBe(2187); // 2232 - 2232*0.02 = 2187.36 → 2187

      // bar.low (2132) <= trailingStop (2187) → trailing_profit
      expect(result.exitReason).toBe("trailing_profit");
      // bar.open (2153) < trailingStop (2187) → open で約定
      expect(result.exitPrice).toBe(2153);

      // 利益: (2153 - 2148) * 100 = ¥500
      // ※実際のバグではbar全体を見ず3秒で決済されてしまった
    });
  });
});

// ============================================================
// intraBarStopModel（SL約定価格のイントラバー・モデル）
// ============================================================

describe("checkPositionExit: intraBarStopModel", () => {
  // KOH-547 の 3276.T 実データ（PSCパラメータ: be=0.3 / trail=0.5 / ATR=37.82）。
  // 建値1656、始値1656（前日終値と同値）、日中1827(+10.3%)まで急騰後に反落し終値1771。
  // 高値1827から作られたトレールは 1827 - 0.5*37.82 = 1808。
  // 始値時点で実在したストップは元SLの1627（maxHigh=1656 < BE発動1667.35 で未発動）。
  const koh547Position = (overrides: Partial<PositionForExit> = {}): PositionForExit => ({
    entryPrice: 1656,
    takeProfitPrice: 1846,
    stopLossPrice: 1627,
    entryAtr: 37.82,
    maxHighDuringHold: 1656,
    minLowDuringHold: 1656,
    currentTrailingStop: null,
    strategy: "post-surge-consolidation",
    holdingBusinessDays: 1,
    beActivationMultiplierOverride: 0.3,
    trailMultiplierOverride: 0.5,
    ...overrides,
  });
  const koh547Bar: BarForExit = { open: 1656, high: 1827, low: 1656, close: 1771 };

  it("既定（end-of-bar）は現行挙動のまま: 高値由来のトレールと始値を比べて始値で約定する", () => {
    const result = checkPositionExit(koh547Position(), koh547Bar);

    // 始値1656 < effectiveSL 1808 なので「ギャップ突破」と誤判定し始値で約定＝建値撤退(±0)
    expect(result.exitPrice).toBe(1656);
    expect(result.exitReason).toBe("trailing_stop");
  });

  it("stop-at-open: 始値時点のストップ(1627)は無傷なので、切り上がったトレール1808で約定する", () => {
    const result = checkPositionExit(
      koh547Position({ intraBarStopModel: "stop-at-open" }),
      koh547Bar,
    );

    expect(result.exitPrice).toBe(1808);
    expect(result.exitReason).toBe("trailing_profit");
  });

  it("stop-at-open: 安値が始値時点のストップを割った日は、切り上がったトレールではなくそのストップで約定する（楽観化させない）", () => {
    // 始値1656で寄ったあと1600まで急落（元SL1627を割る）、その後1827まで戻して1820引け。
    // 安値と高値の前後関係は日足では不明なため、SLに触れた保守側を採らなければ
    // 「実際は損切りされていた日」をトレール利確として記録してしまう。
    const result = checkPositionExit(
      koh547Position({ intraBarStopModel: "stop-at-open" }),
      { open: 1656, high: 1827, low: 1600, close: 1820 },
    );

    expect(result.exitPrice).toBe(1627); // 元SL。1808 でも 1600 でもない
    expect(result.exitReason).toBe("stop_loss");
  });

  it("stop-at-open: 本物のギャップダウン（始値が始値時点のストップ以下）は従来通り始値で約定する", () => {
    // 前日までに高値2200まで伸びてトレール2080が実在する状態で、2060にギャップダウン。
    const result = checkPositionExit(
      makePosition({ maxHighDuringHold: 2200, intraBarStopModel: "stop-at-open" }),
      makeBar({ open: 2060, high: 2070, low: 2050, close: 2055 }),
    );

    expect(result.exitPrice).toBe(2060); // 始値（スリッページ反映）
    expect(result.exitReason).toBe("trailing_profit");
  });

  it("stop-at-open: 当日高値でトレールが切り上がらない日は既定と同じ約定価格になる", () => {
    // 当日高値2070 < 前日までの最高値2200 なので effectiveSL は切り上がらない（2080のまま）
    const position = { maxHighDuringHold: 2200 };
    const bar = makeBar({ open: 2100, high: 2070, low: 2075, close: 2078 });

    const endOfBar = checkPositionExit(makePosition(position), bar);
    const stopAtOpen = checkPositionExit(
      makePosition({ ...position, intraBarStopModel: "stop-at-open" }),
      bar,
    );

    expect(stopAtOpen.exitPrice).toBe(endOfBar.exitPrice);
    expect(stopAtOpen.exitReason).toBe(endOfBar.exitReason);
  });
});
