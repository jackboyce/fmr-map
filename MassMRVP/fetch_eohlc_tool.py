"""
Fetch MRVP (and optionally Section 8 / AHVP) payment standards from the
EOHLC payment standard tool and write to public/data/mrvp/{year}.json.

Source: https://massgov-eohlc.github.io/payment-standard-tool/
Data file: payment_standard_data.json (static JSON, no auth required)

Usage:
  python fetch_eohlc_tool.py            # writes current calendar year
  python fetch_eohlc_tool.py 2026       # writes specific year

The script picks the date range whose window contains Jan 1 of the target
year (matching what the tool calls the "active" standard for that year).
If no range contains that date, it falls back to the most recent expired range.

Output schema per ZIP:
  {
    "town": "Springfield",
    "sro": 900,
    "esro": 990,
    "efficiency": 1100,
    "one_br": 1300,
    "two_br": 1600,
    "three_br": 1900,
    "four_br": 2200
  }

Multi-town ZIPs: the tool sometimes lists multiple towns for one ZIP with
identical values. We take the first town alphabetically and discard the rest.
"""

import sys, json, urllib.request, datetime, os

TOOL_URL = 'https://massgov-eohlc.github.io/payment-standard-tool/payment_standard_data.json'
PROGRAM  = 'mrvp'

KEY_MAP = {
    'efficiency':    'efficiency',
    'one_bedroom':   'one_br',
    'two_bedroom':   'two_br',
    'three_bedroom': 'three_br',
    'four_bedroom':  'four_br',
    'sro':           'sro',
    'esro':          'esro',
}

def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def pick_date_range(program_data, target_date):
    """Return (from_key, to_key, data_dict) for the range containing target_date."""
    ranges = []
    for date_from, obj in program_data.items():
        for date_to, data in obj.items():
            ranges.append((date_from, date_to, data))
    ranges.sort(key=lambda x: x[0])

    td = target_date.toordinal()
    for df, dt, data in ranges:
        if datetime.date.fromisoformat(df).toordinal() <= td <= datetime.date.fromisoformat(dt).toordinal():
            return df, dt, data

    # Fallback: most recent expired range
    expired = [(df, dt, d) for df, dt, d in ranges if datetime.date.fromisoformat(dt).toordinal() < td]
    if expired:
        return expired[-1]
    raise ValueError(f"No date range found for {target_date}")

def convert(raw_zip_data):
    """Convert one ZIP's town dict to our output schema."""
    # Take first town (values are identical across towns for same ZIP)
    town_key = sorted(raw_zip_data.keys())[0]
    src = raw_zip_data[town_key]
    out = {'town': town_key.title()}
    for src_key, dst_key in KEY_MAP.items():
        if src_key in src and src[src_key] not in (None, '', 'NaN'):
            try:
                out[dst_key] = int(float(src[src_key]))
            except (ValueError, TypeError):
                pass
    return out

def main():
    year = int(sys.argv[1]) if len(sys.argv) > 1 else datetime.date.today().year
    target = datetime.date(year, 1, 1)

    print(f"Fetching EOHLC tool data for MRVP year {year}...")
    raw = fetch_json(TOOL_URL)

    if PROGRAM not in raw:
        raise ValueError(f"Program '{PROGRAM}' not found in data. Available: {list(raw.keys())}")

    df, dt, ps_data = pick_date_range(raw[PROGRAM], target)
    print(f"  Using date range: {df} → {dt}")
    print(f"  ZIPs in range: {len(ps_data)}")

    out = {}
    for zip_code, town_data in ps_data.items():
        zip_str = str(zip_code).zfill(5)
        out[zip_str] = convert(town_data)

    out = dict(sorted(out.items()))

    out_path = os.path.normpath(os.path.join(
        os.path.dirname(__file__), '..', 'public', 'data', 'mrvp', f'{year}.json'
    ))
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)

    print(f"  Wrote {len(out)} ZIPs → {out_path}")

if __name__ == '__main__':
    main()
