"""
JPX 上場銘柄一覧 XLS をダウンロードして CSV に変換する。

JPX が公開する data_j.xls をダウンロードし、jpx-csv-sync.ts が読み込む形式の
CSV (data/data_j.csv) に変換して保存する。

Usage:
  python scripts/download_jpx_csv.py
"""

import csv
import os
import sys
from pathlib import Path

import requests
import xlrd

JPX_XLS_URL = (
    "https://www.jpx.co.jp/markets/statistics-equities/misc/"
    "tvdivq0000001vg2-att/data_j.xls"
)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_CSV = PROJECT_ROOT / "data" / "data_j.csv"
DOWNLOAD_TIMEOUT_SEC = 60


def download_xls() -> bytes:
    print(f"[1/3] JPX XLS ダウンロード: {JPX_XLS_URL}")
    response = requests.get(JPX_XLS_URL, timeout=DOWNLOAD_TIMEOUT_SEC)
    response.raise_for_status()
    print(f"  完了: {len(response.content):,} bytes")
    return response.content


def convert_to_csv(xls_bytes: bytes, output_path: Path) -> int:
    print("[2/3] XLS → CSV 変換中...")
    workbook = xlrd.open_workbook(file_contents=xls_bytes)
    sheet = workbook.sheet_by_index(0)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    rows_written = 0
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        for row_idx in range(sheet.nrows):
            row_values = []
            for col_idx in range(sheet.ncols):
                cell = sheet.cell(row_idx, col_idx)
                # XLDateは無し、全てテキストとして書き出す
                value = cell.value
                if isinstance(value, float) and value.is_integer():
                    value = str(int(value))
                else:
                    value = str(value)
                row_values.append(value.strip())
            writer.writerow(row_values)
            rows_written += 1

    print(f"  完了: {rows_written:,} 行 → {output_path}")
    return rows_written


def main() -> int:
    try:
        xls_bytes = download_xls()
        rows = convert_to_csv(xls_bytes, OUTPUT_CSV)

        print("[3/3] サマリー")
        print(f"  CSV出力: {OUTPUT_CSV}")
        print(f"  銘柄行数: {rows - 1}  (ヘッダー除く)")
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
