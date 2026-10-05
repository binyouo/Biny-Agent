#!/usr/bin/env python3
"""Dump the actual rendered geometry of a panel: every element's rect + its text."""
import json, os, sys, argparse, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from livepanel import Chrome, find_exe, CHROME_NAMES, build_page

ap = argparse.ArgumentParser()
ap.add_argument("--config", required=True)
ap.add_argument("--chrome")
ap.add_argument("--t", type=float, default=3.75)
ap.add_argument("--w", type=float, default=1200)
a = ap.parse_args()

chrome = find_exe(a.chrome, CHROME_NAMES, "Chrome")
out_html = tempfile.mktemp(suffix=".html")
build_page(a.config, out_html)
JS = """
(()=>{var ST=document.getElementById('stage'), sr=ST.getBoundingClientRect();
  var sc=sr.width/W;
  function R(rc){return [Math.round((rc.left-sr.left)/sc),Math.round((rc.top-sr.top)/sc),
                         Math.round((rc.right-sr.left)/sc),Math.round((rc.bottom-sr.top)/sc)]}
  var rows=[];
  ST.querySelectorAll('[data-t]').forEach(function(el){
    rows.push({k:el.getAttribute('data-t'),r:R(el.getBoundingClientRect()),
               txt:(el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,72)});
  });
  return rows;})()
""".replace("W", str(a.w))
with Chrome(chrome, 1200, 1500) as c:
    c.open("file://" + out_html)
    c.seek(a.t)
    for r in c.eval(JS):
        x0,y0,x1,y1 = r["r"]
        print(f'{r["k"]:<6} [{x0:>4},{y0:>4} → {x1:>4},{y1:>4}]  {r["txt"]}')
