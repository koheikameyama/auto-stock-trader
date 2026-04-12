# 進化的記憶システム - Evolution Protocol

## コンセプト

**「痛みの蓄積を通じて学習内容を自動的に進化させる」**

同じ問題が繰り返し発生した場合、その記憶を自動的に強制力の高い場所へ昇格させることで、Claude Codeが「使うたびに賢くなる」仕組みを実現します。

## pain_count機構

同じフィードバックや問題が繰り返し発生すると、**pain_count**が自動的に加算され、強制力が段階的に上昇します。

### 昇格レベル

| レベル | pain_count | 保存場所 | 強制力 | 説明 |
|--------|-----------|---------|--------|------|
| 0 | 0 | `memory/daily/` | 最弱 | 日次の観察・決定事項 |
| 1 | 1-2 | `memory/long-term/` | 弱 | 繰り返すパターンとして記録 |
| 2 | 3-4 | `.claude/rules/` | **強** | プロジェクトルールに昇格 |
| 3 | 5+ | `CLAUDE.md` | 最強 | グローバル・プロジェクトルールに明記 |

### 昇格プロトコル

#### 1. daily → long-term（週次振り返り）

**トリガー**: 毎週金曜 19:00（JST）に自動実行

**条件**:
- 同じパターンが週内に2回以上出現
- または重要な決定事項として記録されたもの

**実行**:
```bash
# GitHub Actionsで自動実行
# daily/配下のファイルを分析し、パターンを抽出してlong-term/に移動
```

#### 2. long-term → .claude/rules/（自動昇格）

**トリガー**: pain_count ≥ 3

**条件**:
- 同じ問題が3回以上発生（pain_count: 3）
- または致命的な問題として記録されたもの

**実行**:
1. `memory/long-term/` 内のエントリで `pain_count: 3` 以上のものを検出
2. 該当する `.claude/rules/` ファイルに自動追記（または新規作成）
3. long-term/ から削除（rules/ に統合されたため）

#### 3. .claude/rules/ → CLAUDE.md（手動昇格）

**トリガー**: pain_count ≥ 5 または開発者の判断

**条件**:
- プロジェクト全体に影響する重要なルール
- 他のプロジェクトでも適用すべきパターン

**実行**: 手動でCLAUDE.mdに追記

## メモリの構造

```
memory/
├── daily/              # レベル0: 日次の観察
│   ├── 2026-04-12.md
│   └── 2026-04-13.md
├── short-term/         # プロジェクト固有の一時情報
│   └── current-sprint.md
├── long-term/          # レベル1: 繰り返すパターン
│   ├── prisma-migrations.md
│   ├── n-plus-one-problems.md
│   └── deployment-issues.md
└── evolution.md        # このファイル
```

## フィードバックのフォーマット

### daily/ のエントリ

```markdown
# 2026-04-12

## 決定事項

### エントリーロジックの変更
pain_count: 0
カテゴリ: trading-logic

出来高サージの閾値を2.0倍から2.5倍に変更した。
理由: 誤検知が多すぎるため。

---

### GitHub Actions heredoc エラー
pain_count: 0
カテゴリ: github-actions

YAMLファイル内でheredoc構文を使ったらパースエラーになった。
通常の変数に変更して解決。
```

### long-term/ のエントリ

```markdown
# Prisma マイグレーション事故

pain_count: 3
カテゴリ: database
発生日: 2026-02-22, 2026-02-27, 2026-04-10

## 問題

`prisma migrate resolve --applied` を使うと、SQLが実行されないまま「適用済み」とマークされる。
本番DBで実行すると、カラムが存在しないまま運用が始まり、エラーが発生する。

## 対策

必ず `prisma migrate dev --name xxx` を使う。
シャドウDBエラーが出ても `resolve --applied` には頼らない。

## 昇格条件

pain_count ≥ 3 → `.claude/rules/database.md` に自動昇格予定
```

## 運用ルール

### SessionEnd Hookで自動記録

会話終了時に、その日の決定事項を `memory/daily/YYYY-MM-DD.md` に自動記録します。

```bash
# .claude/hooks/session-end.fish
set today (date +%Y-%m-%d)
set daily_file "memory/daily/$today.md"

# Claude Codeに決定事項の抽出を依頼
# （実装は後述）
```

### 週次振り返り（GitHub Actions）

毎週金曜 19:00（JST）に自動実行：

1. `memory/daily/` 配下のファイルを分析
2. 繰り返すパターンを抽出
3. `memory/long-term/` に移動
4. pain_count ≥ 3 のエントリを `.claude/rules/` に昇格

### 手動レビュー

月次で `memory/long-term/` と `.claude/rules/` をレビューし、不要なエントリを削除。

## 期待効果

- **自動学習**: 同じミスを繰り返さない
- **ルールの自動進化**: 手動でCLAUDE.mdを編集する手間を削減
- **チーム学習**: 個人の失敗がチーム全体のナレッジに昇格
- **コンテキストの最適化**: 重要なルールだけがシステムプロンプトに含まれる

## 参考

- [Claude Codeの進化的記憶システム](https://zenn.dev/tokium_dev/articles/claude-code-evolutionary-memory)
