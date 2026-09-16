import json,math,collections,sys
def S(x,weeks):
    n=len(x)
    if n<2: return f"n={n}"
    m=sum(x)/n; sd=(sum((y-m)**2 for y in x)/(n-1))**.5; gw=sum(y for y in x if y>0); gl=-sum(y for y in x if y<=0)
    cum=pk=dd=0; s=mx=0
    for y in x: cum+=y; pk=max(pk,cum); dd=max(dd,pk-cum); s=s+1 if y<=0 else 0; mx=max(mx,s)
    return f"n={n:4d} /wk={n/weeks:4.1f} win={100*sum(1 for y in x if y>0)/n:4.1f}% exp={m:+.3f}R t={m/(sd/math.sqrt(n)):+.1f} PF={gw/max(gl,1e-9):.2f} net={cum:+.0f}R DD={dd:.0f}R maxL={mx}"
for name,key in (('g1_full','strategy'),('g11_full','engine')):
    j=json.load(open(f'/home/claude/data/{name}.json')); tr=j['trades']
    print('=====',name,S([t['r'] for t in tr],80.2))
    per=collections.defaultdict(list)
    for t in tr:
        p='DEV 2025-03..12' if t['t']<1767225600000 else 'VAL 2026-01..04' if t['t']<1777593600000 else 'HOLD 2026-05..09'; per[p].append(t['r'])
    for k,w in (('DEV 2025-03..12',43.3),('VAL 2026-01..04',17.1),('HOLD 2026-05..09',19.3)): print('  ',k,S(per[k],w))
    g=collections.defaultdict(list)
    for t in tr: g[t[key].split(' (')[0]].append(t['r'])
    for k,v in sorted(g.items()): print('   ',k,S(v,80.2))
    if name=='g11_full':
        g=collections.defaultdict(list)
        for t in tr: g[t['state']].append(t['r'])
        for k,v in sorted(g.items()): print('    state',k,S(v,80.2))
    mo=collections.defaultdict(list)
    for t in tr:
        import datetime; mo[datetime.datetime.utcfromtimestamp(t['t']/1000).strftime('%Y-%m')].append(t['r'])
    print('   months:', ' '.join(f"{k[2:]}:{sum(v):+.0f}" for k,v in sorted(mo.items())))
