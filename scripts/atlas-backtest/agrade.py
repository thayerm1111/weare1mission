import json, glob, bisect, collections, datetime, statistics as st
bars=json.load(open('/tmp/claude-0/bt/bars5_2y.json')); BT=[b[0] for b in bars]
sig=[]
for f in sorted(glob.glob('/tmp/claude-0/bt/atlas_[0-9].jsonl')):
    for l in open(f):
        if l.strip(): sig.append(json.loads(l))
sig.sort(key=lambda x:x['t'])
COOL={'quick':90*60,'hold':180*60,'swing':480*60}
MAXH={'quick':8*12,'hold':24*12,'swing':72*12}
def grade(k, side, entry, stop, tp, maxbars):
    sg=-1 if side=='sell' else 1; risk=abs(entry-stop)
    for m in range(k, min(len(bars), k+maxbars)):
        t,o,h,l,c=bars[m]
        if (side=='sell' and h>=stop) or (side=='buy' and l<=stop): return 'L', -1.0, m
        if (side=='sell' and l<=tp) or (side=='buy' and h>=tp): return 'W', sg*(tp-entry)/risk, m
    m=min(len(bars),k+maxbars)-1
    return 'O', sg*(bars[m][4]-entry)/risk, m
def run(filt=lambda s: True, tpkey='tp1'):
    out=[]; busy=-1; last_t=-10**12; last_style='quick'
    for s in sig:
        if not filt(s): continue
        t=s['t']//1000
        i=bisect.bisect_left(BT, t-300)
        if i<=busy: continue
        if t-last_t < COOL.get(last_style,5400): continue
        entry=s['price']; stop=s['stop']; tp=s[tpkey] or s['tp1']; side=s['side']
        if not ((side=='sell' and tp<entry<stop) or (side=='buy' and tp>entry>stop)): continue
        r,R,end=grade(i+1, side, entry, stop, tp, MAXH.get(s['style'],96))
        risk=abs(entry-stop)
        out.append(dict(t=t,R=R,res=r,risk=risk,cost=0.35/risk,style=s['style'],strategy=s['strategy'],relaxed=s['relaxed'],session=s['session'],conf=s['conf']))
        busy=end; last_t=t; last_style=s['style']
    return out
def line(tr):
    n=len(tr)
    if not n: return 'n=0'
    w=sum(x['res']=='W' for x in tr); R=sum(x['R'] for x in tr); net=sum(x['R']-x['cost'] for x in tr)
    return f"n={n:4d} win%={100*w/n:3.0f} R/tr={R/n:+.2f} net/tr={net/n:+.2f} totNet={net:+.1f}"
cut=1757462400; recent=1789503060
def show(name, tr):
    a=[x for x in tr if x['t']<cut]; b=[x for x in tr if x['t']>=cut]; r=[x for x in tr if x['t']>=recent]
    q=collections.defaultdict(float)
    for x in tr: d=datetime.datetime.utcfromtimestamp(x['t']); q[f"{d.year%100}Q{(d.month-1)//3+1}"]+=x['R']-x['cost']
    print(f"{name:34s} Y1 {line(a)} | Y2 {line(b)} | +q {sum(v>0 for v in q.values())}/{len(q)} | since09-11 {line(r)}")
if __name__=='__main__':
    print('ready signals', len(sig), 'relaxed', sum(s['relaxed'] for s in sig))
    allt=run(); show('ATLAS new rule (0.8 relax)', allt)
    show('ATLAS old rule (no relax)', run(lambda s: not s['relaxed']))
    show('new rule, TP = extended objective', run(tpkey='tp2'))
    for k in ('style','strategy','session','relaxed'):
        g=collections.defaultdict(list)
        for x in allt: g[x[k]].append(x)
        print('--',k)
        for kk,v in sorted(g.items(), key=lambda kv:-len(kv[1])): show(f'   {kk}', v)
