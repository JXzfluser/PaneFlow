import json, sys

b = json.load(sys.stdin)
print("space:", b.get("space"), "| note:", b.get("spaceNote"))
ts = b.get("templates", [])
print("templates:", len(ts))
for t in ts:
    need = " · ".join("%s %s" % (n["label"], n["declared"]) for n in t["need"]) or "没带能力槽"
    marks = {"ok": "✓", "missing": "✗", "unjudged": "?", "malformed": "⚠"}
    line = " ".join("%s%s" % (marks.get(s["verdict"], s["verdict"]), s["kind"]) for s in t["slots"])
    print("  %-40s ok=%-5s %-20s %s" % (t["template"], t["ok"], need, line))
