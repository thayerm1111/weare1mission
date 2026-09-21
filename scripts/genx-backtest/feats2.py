from life import *
# hourly & 4h closes for EMA features
H={}; 
for t,o,h,l,c in bars: H[t//3600]=c
hk=sorted(H); hc=[H[k] for k in hk]
def ema(v,n):
    k=2/(n+1); e=v[0]; o=[]
    for x in v: e=x*k+e*(1-k); o.append(e)
    return o
e20=ema(hc,20); e50=ema(hc,50); e200=ema(hc,200)
def hidx(t): return bisect.bisect_left(hk, t//3600)-1
def feats(s, i):
    t=s['t']; side=s['side']; sg=1 if side=='buy' else -1; j=hidx(t)
    f={}
    f['slope20']=sg*(e20[j]-e20[j-5]) if j>5 else 0
    f['stack']= sg*(1 if e20[j]>e50[j]>e200[j] else -1 if e20[j]<e50[j]<e200[j] else 0)
    f['above200']= sg*(1 if hc[j]>e200[j] else -1)
    seg=bars[max(0,i-288):i+1]; lo=min(b[3] for b in seg); hi=max(b[2] for b in seg); c=bars[i][4]
    rp=(c-lo)/(hi-lo) if hi>lo else .5
    f['rp24']= rp if side=='buy' else 1-rp
    seg=bars[max(0,i-12):i+1]; f['mom1h']=sg*(bars[i][4]-seg[0][4])/max(atr5(i),1e-9)
    f['atr']=atr5(i)
    return f
