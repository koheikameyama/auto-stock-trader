import { describe, it, expect } from "vitest";
import {
  EXIT_REASON,
  classifyExitReason,
  exitReasonLabel,
  isDefensiveExit,
} from "../exit-reason";

describe("classifyExitReason", () => {
  it("コードをそのまま正準化する（新データ）", () => {
    expect(classifyExitReason(EXIT_REASON.STOP_LOSS)).toMatchObject({ code: "stop_loss", defensive: true });
    expect(classifyExitReason(EXIT_REASON.TRAILING_STOP)).toMatchObject({ code: "trailing_stop", defensive: true });
    expect(classifyExitReason(EXIT_REASON.TRAILING_PROFIT)).toMatchObject({ code: "trailing_profit", defensive: false });
    expect(classifyExitReason(EXIT_REASON.TAKE_PROFIT)).toMatchObject({ code: "take_profit", defensive: false });
    expect(classifyExitReason(EXIT_REASON.TIME_STOP)).toMatchObject({ code: "time_stop", defensive: true });
    expect(classifyExitReason(EXIT_REASON.CRISIS)).toMatchObject({ code: "crisis", defensive: true });
    expect(classifyExitReason(EXIT_REASON.EARNINGS)).toMatchObject({ code: "earnings", defensive: false });
    expect(classifyExitReason(EXIT_REASON.SUPERVISION)).toMatchObject({ code: "supervision", defensive: false });
  });

  it("旧日本語ラベル（合成文字列・損益埋め込み含む）を正準コードに束ねる", () => {
    expect(classifyExitReason("損切り").code).toBe("stop_loss");
    expect(classifyExitReason("SL約定（ブローカー自律執行）").code).toBe("stop_loss");
    expect(classifyExitReason("SL約定（ブローカー自律執行・照合リカバリ）").code).toBe("stop_loss");
    expect(classifyExitReason("トレーリング建値撤退").code).toBe("trailing_stop");
    expect(classifyExitReason("トレーリング利確").code).toBe("trailing_profit");
    expect(classifyExitReason("タイムストップ").code).toBe("time_stop");
    expect(classifyExitReason("決算前強制決済（決算まで2日）").code).toBe("earnings");
    expect(classifyExitReason("監理・整理銘柄強制売却（監理）").code).toBe("supervision");
    expect(
      classifyExitReason("crisis（日経/CMEキルスイッチ） 全ポジション即時決済（含み損益: -0.88%）").code,
    ).toBe("crisis");
  });

  it("建値撤退はトレーリング利確より優先して分類される（順序依存）", () => {
    // "トレーリング建値撤退" は "トレーリング" も含むが、建値撤退＝BE撤退が正
    expect(classifyExitReason("トレーリング建値撤退").code).toBe("trailing_stop");
  });

  it("未知・空は other にフォールバックする", () => {
    expect(classifyExitReason("ブローカー約定（WebSocket）").code).toBe("other");
    expect(classifyExitReason("").code).toBe("other");
    expect(classifyExitReason(null).code).toBe("other");
    expect(classifyExitReason(undefined).code).toBe("other");
  });
});

describe("exitReasonLabel", () => {
  it("コードは日本語ラベルに、旧日本語ラベルはそのまま（other）返す", () => {
    expect(exitReasonLabel("stop_loss")).toBe("損切り");
    expect(exitReasonLabel("trailing_stop")).toBe("トレーリング建値撤退");
    expect(exitReasonLabel("crisis")).toBe("防御決済（キルスイッチ）");
    // other は生文字列を返す
    expect(exitReasonLabel("ブローカー約定（WebSocket）")).toBe("ブローカー約定（WebSocket）");
    expect(exitReasonLabel("")).toBe("不明");
  });
});

describe("isDefensiveExit", () => {
  it("守りの決済（損切り・BE撤退・タイム・防御）だけ true", () => {
    for (const r of ["stop_loss", "trailing_stop", "time_stop", "crisis", "損切り", "トレーリング建値撤退"]) {
      expect(isDefensiveExit(r)).toBe(true);
    }
    for (const r of ["trailing_profit", "take_profit", "earnings", "supervision", "トレーリング利確", "other"]) {
      expect(isDefensiveExit(r)).toBe(false);
    }
  });
});
