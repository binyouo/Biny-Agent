#!/usr/bin/env python3
"""Pre-flight text-fit check: measure every line of every box against its inner width.

Usage: python3 scripts/fitcheck.py --config config/xx.json
Inner width = w - border(left+right) - padLeft - padRight  (padding-right defaults to padLeft).
Exit 1 if any line is too wide, printing the overflow in px.
"""
import json, os, sys, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from livepanel import Chrome, find_exe, CHROME_NAMES

FONT = '"JetBrains Mono","IBM Plex Mono","DejaVu Sans Mono","Noto Sans Mono CJK SC",monospace'


def line_text(l):
    if isinstance(l, str):
        return l
    if "t" in l:
        return l["t"]
    if "runs" in l:
        out = []
        for r in l["runs"]:
            if isinstance(r, str):
                out.append(r)
            elif "t" in r:
                out.append(r["t"])
            elif "v" in r:
                out.append("M" * 8)   # machine var placeholder, generous
            elif "sw" in r:
                out.append("  ")
        return "".join(out)
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--chrome")
    a = ap.parse_args()
    cfg = json.load(open(a.config, encoding="utf-8"))
    th = cfg.get("theme", {})
    fs = th.get("fontSize", 21)
    border = th.get("borderWidth", 2)

    jobs, meta = [], []
    for i, e in enumerate(cfg.get("elements", [])):
        if e.get("type") != "box" or e.get("container"):
            continue
        pad = e.get("pad", [10, 14, 14])
        pl, pr = pad[1], (pad[2] if pad[2] is not None else pad[1])
        bw = e.get("border", border)
        inner = e["w"] - 2 * bw - pl - pr
        for l in e.get("lines", []):
            txt = line_text(l)
            if not txt.strip():
                continue
            indent = l.get("indent", 0) if isinstance(l, dict) else 0
            size = l.get("size", fs) if isinstance(l, dict) else fs
            jobs.append((i, txt, indent, size, inner, e["x"], e["w"]))
            meta.append((e.get("lines", []).index(l)))

    chrome = find_exe(a.chrome, CHROME_NAMES, "Chrome")
    with Chrome(chrome, 1200, 1500) as c:
        c.cmd("Page.navigate", {"url": "data:text/html,<meta charset=utf-8><body>"})
        bad = 0
        for (i, txt, indent, size, inner, bx, bw_) in jobs:
            w = c.eval(f"(()=>{{var x=document.createElement('canvas').getContext('2d');"
                       f"x.font={json.dumps(str(size)+'px '+FONT)};return x.measureText({json.dumps(txt, ensure_ascii=False)}).width}})()")
            need = w + indent
            if need > inner:
                bad += 1
                print(f"OVERFLOW box#{i} x={bx} w={bw_} inner={inner:.0f} need={need:.0f} "
                      f"(+{need-inner:.0f}) size={size} :: {txt}")
        print(f"\n{len(jobs)} lines checked, {bad} overflow")
        return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
