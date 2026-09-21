import json, bisect, datetime, collections, math, sys
bars=json.load(open('' + (__import__('sys').argv[1] if len(__import__('sys').argv)>1 else 'bars5_2y.json') + '')); BT=[b[0] for b in bars]; N=len(bars)
def isopen(t):
    d=datetime.datetime.utcfromtimestamp(t); wd=d.weekday(); h=d.hour
    return not (wd==5 or (wd==4 and h>=21) or (wd==6 and h<22))
OPEN=[isopen(b[0]) for b in bars]
# hourly closes (open market only) + EMAs
H={}
for t,o,h,l,c in bars:
    if isopen(t): H[t//3600]=c
hk=sorted(H); hc=[H[k] for k in hk]
def ema(v,n):
    k=2/(n+1); e=v[0]; o=[]
    for x in v: e=x*k+e*(1-k); o.append(e)
    return o
e20,e50,e200=ema(hc,20),ema(hc,50),ema(hc,200)
def hidx(t): return bisect.bisect_left(hk, t//3600)-1
def stack(t):
    j=hidx(t)
    if j<200: return 'mixed'
    return 'up' if e20[j]>e50[j]>e200[j] else 'down' if e20[j]<e50[j]<e200[j] else 'mixed'
def eff(t, n=12):
    j=hidx(t)
    if j<n: return .5
    seg=hc[j-n:j+1]; net=abs(seg[-1]-seg[0]); p=sum(abs(seg[k+1]-seg[k]) for k in range(len(seg)-1))
    return net/p if p else 0
ATR=[0.0]*N
for i in range(1,N):
    tr=max(bars[i][2]-bars[i][3],abs(bars[i][2]-bars[i-1][4]),abs(bars[i][3]-bars[i-1][4]))
    ATR[i]=tr if i<15 else ATR[i-1]+(tr-ATR[i-1])/14
def signals(P):
    out=[]; last=-10**9
    L=P['lookback']
    for i in range(L+2, N-1):
        t=bars[i][0]+300
        if not OPEN[i] or i-last<P['gap']: continue
        seg=bars[i-L:i]  # prior bars, excluding the signal bar
        hi=max(b[2] for b in seg); lo=min(b[3] for b in seg); w=hi-lo; a=ATR[i]
        if a<=0 or w < P['minw']*a: continue
        if P['regime']:
            if stack(t)!='mixed' or eff(t)>P['maxeff']: continue
        o,h,l,c=bars[i][1],bars[i][2],bars[i][3],bars[i][4]
        rng=max(h-l,1e-9)
        # SELL: bar tagged the top band and closed back inside, bearish rejection
        if h>=hi-P['band']*w and c<o and c<hi-P['band']*w*0.5 and (h-max(o,c))/rng>=P['wick'] and h<=hi+P['over']*a:
            stop=max(h,hi)+P['pad']*a; tp1=(hi+lo)/2; tp2=lo+0.15*w
            if c-tp1>0 and (c-tp1)/(stop-c)>=P['minrr']: out.append((i,'sell',c,stop,tp1,tp2)); last=i
        elif l<=lo+P['band']*w and c>o and c>lo+P['band']*w*0.5 and (min(o,c)-l)/rng>=P['wick'] and l>=lo-P['over']*a:
            stop=min(l,lo)-P['pad']*a; tp1=(hi+lo)/2; tp2=hi-0.15*w
            if tp1-c>0 and (tp1-c)/(c-stop)>=P['minrr']: out.append((i,'buy',c,stop,tp1,tp2)); last=i
    return out
def outcome(i, side, e, st, tp, maxb=96, be=None):
    sg=1 if side=='buy' else -1; risk=abs(e-st); cur=st; mfe=0.0; hit1=None
    for m in range(i+1, min(N,i+1+maxb)):
        _,o,h,l,c=bars[m]
        adv=l if side=='buy' else h; fav=h if side=='buy' else l
        mfe=max(mfe, sg*(fav-e)/risk)
        if hit1 is None and mfe>=1: hit1=True
        if (side=='buy' and adv<=cur) or (side=='sell' and adv>=cur):
            if hit1 is None: hit1=False
            return sg*(cur-e)/risk, mfe, hit1
        if (side=='buy' and fav>=tp) or (side=='sell' and fav<=tp): return sg*(tp-e)/risk, max(mfe,sg*(tp-e)/risk), True if hit1 is None and sg*(tp-e)/risk>=1 else bool(hit1)
        if be and mfe>=be: cur=e
    return sg*(bars[min(N,i+1+maxb)-1][4]-e)/risk, mfe, bool(hit1)
CUT=1757462400
def evaluate(P, label, tpk=4, be=None):
    sig=signals(P); res={'Y1':[], 'Y2':[]}
    for s in sig:
        i,side,e,st,tp1,tp2=s; tp=tp1 if tpk==4 else tp2
        R,mfe,h1=outcome(i,side,e,st,tp,be=be); risk=abs(e-st)
        res['Y1' if bars[i][0]<CUT else 'Y2'].append((R-0.35/risk, mfe, h1, R, bars[i][0]))
    parts=[]
    for k,v in res.items():
        if not v: parts.append(f'{k}: n=0'); continue
        n=len(v); net=sum(x[0] for x in v)
        parts.append(f"{k}: n={n} net/tr={net/n:+.2f} +1R-first={100*sum(1 for x in v if x[2])/n:.0f}% medMFE={sorted(x[1] for x in v)[n//2]:.2f}R win={100*sum(1 for x in v if x[3]>0)/n:.0f}%")
    q=collections.defaultdict(float)
    for v in res.values():
        for x in v: d=datetime.datetime.utcfromtimestamp(x[4]); q[f'{d.year%100}Q{(d.month-1)//3+1}']+=x[0]
    print(f"{label:40s} "+" | ".join(parts)+f" | +q {sum(1 for x in q.values() if x>0)}/{len(q)}")
    return res
BASE=dict(lookback=144, minw=6, band=0.15, wick=0.3, over=0.5, pad=0.3, minrr=0.8, gap=12, regime=True, maxeff=0.35)
if __name__=='__main__':
    evaluate(BASE,'base (12h range, regime on)')
    evaluate(dict(BASE,regime=False),'no regime filter')
    evaluate(dict(BASE,lookback=288),'24h range')
    evaluate(BASE,'base, TP = far edge', tpk=5)
    evaluate(BASE,'base, BE at 1R (AI manages)', be=1.0)
    evaluate(dict(BASE,wick=0.45),'stronger wick')
    evaluate(dict(BASE,minw=8),'wider ranges only')
