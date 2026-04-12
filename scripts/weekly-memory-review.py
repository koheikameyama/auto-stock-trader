#!/usr/bin/env python3
"""
週次メモリ振り返りスクリプト

memory/daily/ 配下のファイルを分析し、繰り返すパターンを抽出して
memory/long-term/ に移動する。

pain_count ≥ 3 のエントリは .claude/rules/ に昇格する。
"""

import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict
import glob

# プロジェクトルート
PROJECT_ROOT = Path(__file__).parent.parent
DAILY_DIR = PROJECT_ROOT / "memory" / "daily"
LONG_TERM_DIR = PROJECT_ROOT / "memory" / "long-term"
RULES_DIR = PROJECT_ROOT / ".claude" / "rules"

def extract_feedbacks_from_daily():
    """daily/ からフィードバックを抽出"""
    feedbacks = []

    for daily_file in sorted(DAILY_DIR.glob("*.md")):
        if daily_file.name == ".gitkeep":
            continue

        content = daily_file.read_text(encoding="utf-8")
        date = daily_file.stem  # YYYY-MM-DD

        # フィードバックのパターンを抽出
        # フォーマット: ### タイトル\npain_count: N\nカテゴリ: XXX\n本文
        pattern = r'###\s+(.+?)\npain_count:\s*(\d+)\nカテゴリ:\s*(.+?)\n\n(.+?)(?=\n---|$)'
        matches = re.finditer(pattern, content, re.DOTALL)

        for match in matches:
            title = match.group(1).strip()
            pain_count = int(match.group(2))
            category = match.group(3).strip()
            description = match.group(4).strip()

            feedbacks.append({
                'title': title,
                'pain_count': pain_count,
                'category': category,
                'description': description,
                'date': date,
                'source_file': daily_file
            })

    return feedbacks

def group_by_category(feedbacks):
    """カテゴリごとにグループ化"""
    grouped = defaultdict(list)
    for fb in feedbacks:
        grouped[fb['category']].append(fb)
    return grouped

def detect_patterns(feedbacks):
    """繰り返すパターンを検出"""
    # タイトルの類似性でグループ化（簡易版：完全一致）
    patterns = defaultdict(list)

    for fb in feedbacks:
        key = fb['title'].lower().strip()
        patterns[key].append(fb)

    # 2回以上出現したものをパターンとして返す
    repeated_patterns = {k: v for k, v in patterns.items() if len(v) >= 2}
    return repeated_patterns

def create_long_term_entry(category, feedbacks):
    """long-term/ にエントリを作成"""
    # ファイル名: カテゴリ名.md
    filename = f"{category}.md"
    filepath = LONG_TERM_DIR / filename

    # タイトルは最初のフィードバックから取得
    title = feedbacks[0]['title']
    pain_count = len(feedbacks)  # 出現回数がpain_count
    dates = ", ".join([fb['date'] for fb in feedbacks])

    # 説明は全てのフィードバックをまとめる
    descriptions = "\n\n".join([
        f"**{fb['date']}:**\n{fb['description']}"
        for fb in feedbacks
    ])

    content = f"""# {title}

pain_count: {pain_count}
カテゴリ: {category}
発生日: {dates}

## 問題

{descriptions}

## 対策

<!-- ここに対策を記述してください -->

## 昇格条件

pain_count ≥ 3 → `.claude/rules/{category}.md` に自動昇格予定
"""

    filepath.write_text(content, encoding="utf-8")
    print(f"✅ Created long-term entry: {filepath}")
    return filepath, pain_count

def promote_to_rules(category, long_term_file):
    """pain_count ≥ 3 のエントリを .claude/rules/ に昇格"""
    rules_file = RULES_DIR / f"{category}.md"

    content = long_term_file.read_text(encoding="utf-8")

    # すでにrulesファイルが存在する場合は追記、存在しない場合は新規作成
    if rules_file.exists():
        print(f"⚠️  Rules file already exists: {rules_file}")
        print(f"   Manual review required. Please merge content from {long_term_file}")
    else:
        rules_file.write_text(content, encoding="utf-8")
        print(f"🚀 Promoted to rules: {rules_file}")

        # long-term から削除
        long_term_file.unlink()
        print(f"🗑️  Removed from long-term: {long_term_file}")

def main():
    print("=" * 60)
    print("週次メモリ振り返り - Weekly Memory Review")
    print("=" * 60)
    print()

    # 1. daily/ からフィードバックを抽出
    print("📖 Extracting feedbacks from memory/daily/...")
    feedbacks = extract_feedbacks_from_daily()

    if not feedbacks:
        print("ℹ️  No feedbacks found in daily/")
        return

    print(f"   Found {len(feedbacks)} feedbacks")
    print()

    # 2. カテゴリごとにグループ化
    print("📊 Grouping by category...")
    grouped = group_by_category(feedbacks)
    print(f"   Found {len(grouped)} categories")
    print()

    # 3. パターン検出
    print("🔍 Detecting patterns...")
    patterns = detect_patterns(feedbacks)
    print(f"   Found {len(patterns)} repeated patterns")
    print()

    # 4. long-term/ にエントリを作成
    if patterns:
        print("📝 Creating long-term entries...")
        for pattern_key, pattern_feedbacks in patterns.items():
            category = pattern_feedbacks[0]['category']
            filepath, pain_count = create_long_term_entry(category, pattern_feedbacks)

            # pain_count ≥ 3 なら .claude/rules/ に昇格
            if pain_count >= 3:
                print(f"   🔥 pain_count = {pain_count} ≥ 3, promoting to rules...")
                promote_to_rules(category, filepath)
        print()

    # 5. サマリー
    print("=" * 60)
    print("Summary:")
    print(f"  - Feedbacks processed: {len(feedbacks)}")
    print(f"  - Patterns detected: {len(patterns)}")
    print(f"  - Long-term entries created: {len(patterns)}")
    print("=" * 60)
    print()
    print("✨ Weekly review completed!")

if __name__ == "__main__":
    main()
