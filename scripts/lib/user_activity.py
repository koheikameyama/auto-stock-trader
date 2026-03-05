"""
ユーザーアクティビティフィルタリング

バッチ処理で非アクティブユーザーを除外するためのヘルパー。
lastActivityAt が INACTIVE_THRESHOLD_DAYS 日以上前のユーザー、
または lastActivityAt が NULL かつ createdAt が INACTIVE_THRESHOLD_DAYS 日以上前のユーザーを除外。
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.constants import INACTIVE_THRESHOLD_DAYS


def get_active_user_filter_sql(alias: str = "u") -> str:
    """
    SQL WHERE句の条件文字列を返す。

    条件:
    - lastActivityAt が N日以内 → アクティブ
    - lastActivityAt が NULL かつ createdAt が N日以内 → 新規ユーザー（アクティブ扱い）
    - それ以外 → 非アクティブ（除外）

    Args:
        alias: Userテーブルのエイリアス（デフォルト: "u"）
    """
    return f'''(
        {alias}."lastActivityAt" >= NOW() - INTERVAL '{INACTIVE_THRESHOLD_DAYS} days'
        OR ({alias}."lastActivityAt" IS NULL AND {alias}."createdAt" >= NOW() - INTERVAL '{INACTIVE_THRESHOLD_DAYS} days')
    )'''
