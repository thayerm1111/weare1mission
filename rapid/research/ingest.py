#!/usr/bin/env python3
"""
Turn a saved Supabase tool-result into a replay window file.

The result is JSON whose single string field contains the rows, so the outer envelope is parsed
first and the inner JSON array second. The database computes the md5 of the payload; if the copy on
disk does not hash to the same value the window is NOT written, because evaluating a strategy on
silently corrupted prices is worse than not evaluating it at all.
"""
import hashlib, json, os, sys

src, dst = sys.argv[1], sys.argv[2]
outer = json.load(open(src, encoding="utf-8"))
text = outer["result"] if isinstance(outer, dict) and "result" in outer else open(src, encoding="utf-8").read()
i, j = text.find("[{"), text.rfind("}]")
r = json.loads(text[i:j + 2])[0]

payload = r["payload"]
got = hashlib.md5(payload.encode()).hexdigest()
if got != r["md5"]:
    sys.exit(f"CHECKSUM MISMATCH: the database says {r[chr(39)+chr(39)] if False else r['md5']}, this copy hashes to {got}")
n = payload.count(";") + 1
if n != r["bars"]:
    sys.exit(f"BAR COUNT MISMATCH: the database says {r['bars']}, this copy has {n}")

os.makedirs(os.path.dirname(dst), exist_ok=True)
with open(dst, "w", encoding="utf-8") as f:
    f.write(f"{r['t0']} {r['p0']} {r['bars']} {r['md5']}\n{payload}\n")
print(f"{dst}: {r['bars']} bars, md5 {r['md5']} verified against the database")

