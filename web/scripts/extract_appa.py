"""Extract Appa's spreadsheet into web/lib/data/appa.json (stdlib only).
Real history: weight / fluid / sugar / BP / SpO2 / diuretic doses (sheet 'weight'), labs ('lab tests summary').
Usage: python3 extract_appa.py <xlsx> <out.json>
"""
import sys, json, re, zipfile, datetime, xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
z = zipfile.ZipFile(sys.argv[1])
ss = ["".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS)]
wb = ET.fromstring(z.read("xl/workbook.xml"))
rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}


def sheet(name):
    for s in wb.find("m:sheets", NS):
        if s.get("name") == name:
            tgt = rels[s.get("{%s}id" % NS["r"])].lstrip("/")
            tgt = tgt if tgt.startswith("xl/") else "xl/" + tgt
            out = []
            for row in ET.fromstring(z.read(tgt)).findall(".//m:sheetData/m:row", NS):
                cells = {}
                for c in row.findall("m:c", NS):
                    v = c.find("m:v", NS)
                    if v is None:
                        continue
                    col = re.match(r"[A-Z]+", c.get("r")).group(0)
                    cells[col] = ss[int(v.text)] if c.get("t") == "s" else v.text
                out.append(cells)
            return out
    raise KeyError(name)


def d(serial):
    return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(float(serial)))).isoformat()


def f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


data = {"weight": [], "fluid": [], "glucose": [], "bp": [], "spo2": [], "diuretic": [], "labs": []}

# ---- daily log sheet
for c in sheet("weight")[1:]:
    if f(c.get("B")) is None:
        continue
    day = d(c["B"])
    if f(c.get("C")):
        data["weight"].append({"d": day, "kg": f(c["C"])})
    if f(c.get("N")) and f(c.get("O")):
        data["fluid"].append({"d": day, "in": f(c["N"]), "out": f(c["O"])})
    if f(c.get("H")) or f(c.get("I")):
        data["glucose"].append({"d": day, "f": f(c.get("H")), "pp": f(c.get("I"))})
    if f(c.get("K")) and f(c.get("L")):
        data["bp"].append({"d": day, "s": f(c["K"]), "di": f(c["L"])})
    sp = f(c.get("M"))
    if sp:
        data["spo2"].append({"d": day, "v": round(sp * 100) if sp <= 1 else sp})
    if f(c.get("J")):
        data["labs"].append({"d": day, "m": "potassium", "v": f(c["J"])})
    # diuretics: Dytor dose text "40mg-20mg" (sum) or mg column E; Zytanix F; Lasix G
    dy = None
    if c.get("D"):
        mgs = [float(x) for x in re.findall(r"(\d+(?:\.\d+)?)\s*mg", c["D"])]
        dy = sum(mgs) if mgs else None
    dy = dy or f(c.get("E"))
    if dy:
        data["diuretic"].append({"d": day, "drug": "Torsemide (Dytor)", "mg": dy})
    if f(c.get("F")):
        data["diuretic"].append({"d": day, "drug": "Metolazone (Zytanix)", "mg": f(c["F"])})
    if f(c.get("G")):
        data["diuretic"].append({"d": day, "drug": "Furosemide (Lasix)", "mg": f(c["G"])})

# ---- labs sheet
MARKERS = {
    "Heamoglobin": "hb", "WBC": "wbc", "HBA1C": "hba1c", "Albumin": "albumin", "Urea": "urea", "Uric Acid": "uric_acid",
    "Creatintine": "creatinine", "eGFR": "egfr", "Sodium": "sodium", "Potassium": "potassium", "Chloride": "chloride",
    "Bicarobonate": "bicarbonate", "Calcium": "calcium", "Phosphorous": "phosphorus", "Magnesium": "magnesium",
    "NT Pro BNP": "ntprobnp", "LDL": "ldl", "Vitamin D": "vitd",
}
SANE = {"phosphorus": (0.5, 15), "hb": (4, 20), "creatinine": (0.2, 15)}
rows = sheet("lab tests summary")
header = rows[1]
dates = {col: d(v) for col, v in header.items() if col != "B" and f(v)}
seen = {(x["d"], x["m"]) for x in data["labs"]}
for r in rows[2:]:
    key = MARKERS.get((r.get("B") or "").strip())
    if not key:
        continue
    for col, day in dates.items():
        v = f(r.get(col))
        if v is None:
            continue
        lo, hi = SANE.get(key, (-1e9, 1e9))
        if not lo <= v <= hi:
            continue
        if (day, key) in seen:
            data["labs"] = [x for x in data["labs"] if not (x["d"] == day and x["m"] == key)]
        data["labs"].append({"d": day, "m": key, "v": v})
data["labs"].sort(key=lambda x: (x["d"], x["m"]))
json.dump(data, open(sys.argv[2], "w"), separators=(",", ":"))
print({k: len(v) for k, v in data.items()}, "labs dates:", len({x["d"] for x in data["labs"]}))
print("fluid range", data["fluid"][0]["d"], data["fluid"][-1]["d"], "weight", data["weight"][0]["d"], data["weight"][-1]["d"])
print("last labs", [x for x in data["labs"] if x["d"] >= "2026-08-20"])
