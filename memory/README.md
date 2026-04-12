# Memory - 進化的記憶システム

## ディレクトリ構造

```
memory/
├── daily/              # 日次の観察・決定事項（レベル0）
├── short-term/         # プロジェクト固有の一時情報
├── long-term/          # 繰り返すパターン（レベル1）
├── evolution.md        # pain_count管理プロトコル
└── README.md           # このファイル
```

## 使い方

### 1. 日次記録（自動）

SessionEnd Hookが会話終了時に自動的に`daily/YYYY-MM-DD.md`を生成します。

### 2. 週次振り返り（自動）

毎週金曜 19:00（JST）にGitHub Actionsが実行され：
- `daily/`を分析してパターンを抽出
- 繰り返すパターンを`long-term/`に移動
- pain_count ≥ 3 のエントリを`.claude/rules/`に昇格

### 3. 手動記録

重要な決定事項を直接`long-term/`に記録することも可能です：

```markdown
# memory/long-term/example-pattern.md

pain_count: 1
カテゴリ: database
発生日: 2026-04-12

## 問題
...

## 対策
...
```

### 4. pain_countの更新

同じ問題が再発した場合、該当ファイルの`pain_count`を手動で増やします：

```markdown
pain_count: 2  # 1 → 2 に更新
発生日: 2026-04-12, 2026-04-15  # 日付を追加
```

## 昇格フロー

```
daily/ (pain_count: 0)
  ↓ 週次振り返り（パターン検出）
long-term/ (pain_count: 1-2)
  ↓ pain_count ≥ 3
.claude/rules/ (強制力: 強)
  ↓ pain_count ≥ 5 または手動判断
CLAUDE.md (強制力: 最強)
```

詳細は `evolution.md` を参照してください。
