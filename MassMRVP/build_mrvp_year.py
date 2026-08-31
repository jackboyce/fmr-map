"""
Build public/data/mrvp/{year}.json from ODS source files in MassMRVP/sources/.

Source files must be named:  {year}_{provider}.ods
  e.g.  2026_bha.ods, 2026_eohlc.ods

Each ODS must have columns (exact names, case-insensitive):
  Zip | City | 0 BR | 1BR | 2BR | 3BR | 4BR

If multiple sources cover the same ZIP, the last file alphabetically wins
(so name files with a priority suffix, e.g. 2026_a_bha.ods, 2026_b_eohlc.ods
to have eohlc override bha).

Usage:
  python build_mrvp_year.py 2026
"""

import sys, json, re, glob, os
import pandas as pd

def norm_col(c):
    return re.sub(r'\s+', '', str(c)).lower()

COL_MAP = {
    '0br': 'efficiency',
    '1br': 'one_br',
    '2br': 'two_br',
    '3br': 'three_br',
    '4br': 'four_br',
}

def load_ods(path):
    df = pd.read_excel(path, engine='odf', dtype=str)
    df.columns = [norm_col(c) for c in df.columns]

    out = {}
    for _, row in df.iterrows():
        zip_raw = str(row.get('zip', '')).strip().split('.')[0]
        if not re.match(r'^\d{4,5}$', zip_raw):
            continue
        zip_code = zip_raw.zfill(5)
        town = str(row.get('city', '')).strip()

        entry = {'town': town}
        for src, dst in COL_MAP.items():
            val = row.get(src)
            if val and str(val).strip() not in ('', 'nan'):
                try:
                    entry[dst] = int(str(val).replace('$', '').replace(',', '').strip())
                except ValueError:
                    pass
        out[zip_code] = entry
    return out

def main():
    if len(sys.argv) < 2:
        print("Usage: python build_mrvp_year.py <year>")
        sys.exit(1)

    year = sys.argv[1]
    src_dir = os.path.join(os.path.dirname(__file__), 'sources')
    pattern = os.path.join(src_dir, f'{year}_*.ods')
    files = sorted(glob.glob(pattern))

    if not files:
        print(f"No source files found matching {pattern}")
        sys.exit(1)

    merged = {}
    for path in files:
        provider = os.path.basename(path)
        data = load_ods(path)
        print(f"  {provider}: {len(data)} ZIPs")
        merged.update(data)  # later files override earlier

    merged = dict(sorted(merged.items()))  # sort by ZIP

    out_path = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'mrvp', f'{year}.json')
    out_path = os.path.normpath(out_path)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(merged, f, indent=2)

    print(f"\nWrote {len(merged)} ZIPs → {out_path}")

if __name__ == '__main__':
    main()
