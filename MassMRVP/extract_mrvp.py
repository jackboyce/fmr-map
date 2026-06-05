"""
Extract MRVP payment standard data from PDFs into JSON files
for use by the FMR Map app.

Output: public/data/mrvp/{year}.json
  - 2024.json: keyed by ZIP code
  - 2025.json: keyed by ZIP code
  - 2023.json: keyed by normalized town name (area-wide FMR, no ZIP data)
"""
import pdfplumber, json, re, os, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

FOLDER   = r'C:\Users\jackb\Documents\FMRMap\MassMRVP'
OUT_DIR  = r'C:\Users\jackb\Documents\FMRMap\public\data\mrvp'
os.makedirs(OUT_DIR, exist_ok=True)

def parse_amount(s):
    """Parse a dollar string like '$1,276' or '$ 1 ,276' into int."""
    if not s: return None
    clean = re.sub(r'[$,\s]', '', str(s))
    try: return int(clean)
    except: return None

def find_amounts(text):
    """Find all dollar amounts in a string, handling spaced formatting."""
    # Match patterns like $1,234 or $ 1 ,234
    raw = re.findall(r'\$\s*[\d][\d,\s]*', text)
    return [parse_amount(r) for r in raw if parse_amount(r) is not None]

def amounts_to_record(amounts, has_sro=True, town=None):
    """Map a list of amounts to bedroom key dict.
    2023/2025: [SRO, ESRO, 0BR, 1BR, 2BR, 3BR, 4BR, ...]
    2024:      [0BR, 1BR, 2BR, 3BR, 4BR, ...]  (no SRO/ESRO)
    """
    rec = {}
    if town: rec['town'] = town
    if has_sro:
        keys = ['sro','esro','efficiency','one_br','two_br','three_br','four_br']
    else:
        keys = ['efficiency','one_br','two_br','three_br','four_br']
    for i, k in enumerate(keys):
        if i < len(amounts) and amounts[i]: rec[k] = amounts[i]
    return rec

# ── FY2024 — ZIP-keyed, no SRO/ESRO ──────────────────────────────────────────
print("Parsing FY2024...")
data_2024 = {}
pdf_path = f'{FOLDER}\\EOHLC State Payment Standards Ceiling Rents eff. 03012024.pdf'
with pdfplumber.open(pdf_path) as pdf:
    for page in pdf.pages:
        for table in page.extract_tables():
            for row in table:
                if not row or not row[0]: continue
                zip_raw = str(row[0]).strip().replace('\n','')
                if not re.match(r'^\d{5}$', zip_raw): continue
                town = str(row[1]).strip() if row[1] else ''
                amounts = []
                for cell in row[2:]:
                    v = parse_amount(cell)
                    if v: amounts.append(v)
                if len(amounts) >= 5:
                    data_2024[zip_raw] = amounts_to_record(amounts, has_sro=False, town=town)
print(f"  {len(data_2024)} ZIP entries")

# ── FY2025 — ZIP-keyed, includes SRO/ESRO ────────────────────────────────────
# Jan 2025 doc: "01001 Agawam $957 $1,053 $1,276 $1,474 $1,826 ..."
print("Parsing FY2025...")
data_2025 = {}
pdf_path = f'{FOLDER}\\MRVP Applicable Payment Standards 1.1.25 (1).pdf'
with pdfplumber.open(pdf_path) as pdf:
    for page in pdf.pages:
        text = page.extract_text() or ''
        for line in text.splitlines():
            line = line.strip()
            # Match: 5-digit ZIP, optional town name, then dollar amounts
            m = re.match(r'^(\d{5})\s+([A-Za-z][A-Za-z0-9\s\-\.\'\/]*?)\s+\$', line)
            if not m: continue
            zip_code = m.group(1)
            town = m.group(2).strip()
            amounts = find_amounts(line)
            if len(amounts) >= 5:
                data_2025[zip_code] = amounts_to_record(amounts, has_sro=True, town=town)
print(f"  {len(data_2025)} ZIP entries")

# ── FY2023 — town-keyed, area-wide FMR (no ZIP breakdown) ────────────────────
# Format: "Abington $935 $1,028 $1,246 $1,415 $1,863 $2,375 $2,708 $3,114 $3,520"
# Columns: SRO ESRO Studio/0BR 1BR 2BR 3BR 4BR 5BR 6BR
print("Parsing FY2023...")
data_2023 = {}
def norm_town(n):
    return re.sub(r'\s+(town|city|village|town city)$', '', n.lower()).strip()

# PDF uses shortened names; map to canonical GeoJSON names
TOWN_ALIASES = {
    'manchester': 'manchester-by-the-sea',
}

pdf_path = f'{FOLDER}\\MRVP Applicable Payment Standards with Memo.pdf'
with pdfplumber.open(pdf_path) as pdf:
    for page in pdf.pages:
        text = page.extract_text() or ''
        for line in text.splitlines():
            line = line.strip()
            # Must start with a capitalized word and contain dollar amounts
            if not re.match(r'^[A-Z][a-z]', line): continue
            if '$' not in line: continue
            # Extract town name: everything before the first $
            town_part = line[:line.index('$')].strip()
            if not town_part or len(town_part) < 2: continue
            # Use word-boundary check so 'Town' doesn't match 'Townsend', etc.
            if re.search(r'\b(City|Town|Studio|Bedroom|SRO|ESRO)\b', town_part): continue
            amounts = find_amounts(line)
            if len(amounts) >= 5:
                key = norm_town(town_part)
                key = TOWN_ALIASES.get(key, key)
                data_2023[key] = amounts_to_record(amounts, has_sro=True)
print(f"  {len(data_2023)} town entries")

# ── Write JSON ────────────────────────────────────────────────────────────────
for year, data in [(2024, data_2024), (2025, data_2025), (2023, data_2023)]:
    path = f'{OUT_DIR}\\{year}.json'
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',',':'))
    kb = round(os.path.getsize(path)/1024, 1)
    print(f"Wrote {path} ({kb} KB, {len(data)} entries)")

# ── Spot-check ────────────────────────────────────────────────────────────────
print("\n── Spot-check ──")
print("2024 01001 (Agawam):", data_2024.get('01001'))
print("2025 01001 (Agawam):", data_2025.get('01001'))
print("2025 02139 (Cambridge):", data_2025.get('02139'))
print("2025 02115 (Boston):", data_2025.get('02115'))
print("2023 abington:", data_2023.get('abington'))
print("2023 cambridge:", data_2023.get('cambridge'))
print("2023 townsend:", data_2023.get('townsend'))
print("2023 manchester-by-the-sea:", data_2023.get('manchester-by-the-sea'))
