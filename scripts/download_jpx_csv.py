"""
JPX 上場銘柄一覧 XLSX をダウンロードして CSV に変換する。

JPX が公開する data_j.xlsx をダウンロードし、jpx-csv-sync.ts が読み込む形式の
CSV (data/data_j.csv) に変換して保存する。

Usage:
  python scripts/download_jpx_csv.py
"""

import csv
import io
import os
import sys
from pathlib import Path

import openpyxl
import requests

# 2026-09頃にJPX側がファイル形式を .xls → .xlsx に変更（パスのハッシュ値は不変）。
# 旧 .xls URLは404を返すようになった。
JPX_XLSX_URL = (
    "https://www.jpx.co.jp/markets/statistics-equities/misc/"
    "tvdivq0000001vg2-att/data_j.xlsx"
)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_CSV = PROJECT_ROOT / "data" / "data_j.csv"
DOWNLOAD_TIMEOUT_SEC = 60


def download_xlsx() -> bytes:
    print(f"[1/3] JPX XLSX ダウンロード: {JPX_XLSX_URL}")
    response = requests.get(JPX_XLSX_URL, timeout=DOWNLOAD_TIMEOUT_SEC)
    response.raise_for_status()
    print(f"  完了: {len(response.content):,} bytes")
    return response.content


def convert_to_csv(xlsx_bytes: bytes, output_path: Path) -> int:
    print("[2/3] XLSX → CSV 変換中...")
    workbook = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), read_only=True, data_only=True)
    sheet = workbook.worksheets[0]

    output_path.parent.mkdir(parents=True, exist_ok=True)

    rows_written = 0
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        for row in sheet.iter_rows(values_only=True):
            row_values = []
            for value in row:
                if value is None:
                    value = ""
                elif isinstance(value, float) and value.is_integer():
                    value = str(int(value))
                else:
                    value = str(value)
                row_values.append(value.strip())
            writer.writerow(row_values)
            rows_written += 1

    workbook.close()
    print(f"  完了: {rows_written:,} 行 → {output_path}")
    return rows_written


def main() -> int:
    try:
        xlsx_bytes = download_xlsx()
        rows = convert_to_csv(xlsx_bytes, OUTPUT_CSV)

        print("[3/3] サマリー")
        print(f"  CSV出力: {OUTPUT_CSV}")
        print(f"  銘柄行数: {rows - 1}  (ヘッダー除く)")
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
