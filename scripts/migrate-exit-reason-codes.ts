/**
 * 一回限りのマイグレーション: exitSnapshot.exitReason を日本語ラベル → コードに正規化する。
 *
 * 背景: 2026-07 以前は position-monitor / broker-fill-handler が exitReason を日本語の
 * 合成文字列で保存していた（例 "SL約定（ブローカー自律執行）" / "トレーリング建値撤退"）。
 * 書き込み側をコード保存に変更したため、既存データも classifyExitReason でコードに揃える。
 *
 * - 冪等: 2回目以降は全てコード化済みで「更新0件」になる。
 * - "other"（分類不能な自由文＝voidPosition の理由等）は情報を失わないため触らない。
 * - 既定はドライラン。実際に更新するには `--apply` を付ける。
 *
 *   tsx scripts/migrate-exit-reason-codes.ts          # ドライラン（差分表示のみ）
 *   tsx scripts/migrate-exit-reason-codes.ts --apply  # 本番更新
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { classifyExitReason } from "../src/core/exit-reason";

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`[migrate-exit-reason] mode=${apply ? "APPLY" : "DRY-RUN"}`);

  const positions = await prisma.tradingPosition.findMany({
    where: { status: "closed", exitSnapshot: { not: Prisma.JsonNull } },
    select: { id: true, exitSnapshot: true },
  });

  let planned = 0;
  let skippedCode = 0;
  let skippedOther = 0;

  for (const p of positions) {
    const snap = p.exitSnapshot as { exitReason?: string } | null;
    const raw = snap?.exitReason;
    if (!snap || typeof raw !== "string" || raw.length === 0) continue;

    const { code } = classifyExitReason(raw);

    // 既にコード（＝ラベル化前と同じ文字列）ならスキップ
    if (raw === code) {
      skippedCode++;
      continue;
    }
    // 分類不能（自由文）は情報を失わないため触らない
    if (code === "other") {
      console.log(`  [skip:other] ${p.id}: "${raw}"`);
      skippedOther++;
      continue;
    }

    planned++;
    console.log(`  ${apply ? "[update]" : "[would] "} ${p.id}: "${raw}" -> "${code}"`);

    if (apply) {
      await prisma.tradingPosition.update({
        where: { id: p.id },
        data: { exitSnapshot: { ...snap, exitReason: code } },
      });
    }
  }

  console.log(
    `[migrate-exit-reason] 対象closed=${positions.length} / ${apply ? "更新" : "更新予定"}=${planned} / 既にコード=${skippedCode} / other据置=${skippedOther}`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
