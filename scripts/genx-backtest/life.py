import json, glob, bisect, sys, math, collections, datetime
bars=json.load(open('/tmp/claude-0/bt/bars5_2y.json'))
BT=[b[0] for b in bars]
def load_sigs():
    s=[]
    for f in sorted(glob.glob('/tmp/claude-0/bt/sig_[0-9].jsonl')):
        for line in open(f):
            if line.strip(): s.append(json.loads(line))
    import datetime as _d
    def open_(t):
        d=_d.datetime.utcfromtimestamp(t); wd=d.weekday(); h=d.hour
        if wd==5: return False
        if wd==4 and h>=21: return False
        if wd==6 and h<22: return False
        return True
    s=[x for x in s if open_(x['t'])]
    s.sort(key=lambda x:x['t']); return s
def atr5(i,n=14):
    tr=[max(bars[k][2]-bars[k][3],abs(bars[k][2]-bars[k-1][4]),abs(bars[k][3]-bars[k-1][4])) for k in range(i-n+1,i+1)]
    return sum(tr)/n
def grade(k, side, entry, stop, tp, maxbars=96, be=None):
    sgn=-1 if side=='sell' else 1; risk=abs(entry-stop); cur=stop
    for m in range(k, min(len(bars), k+maxbars)):
        t,o,h,l,c=bars[m]
        adv = h if side=='sell' else l; fav = l if side=='sell' else h
        if (side=='sell' and adv>=cur) or (side=='buy' and adv<=cur):
            return ('L' if abs(cur-stop)<1e-9 else 'S'), sgn*(cur-entry)/risk, m
        if (side=='sell' and fav<=tp) or (side=='buy' and fav>=tp):
            return 'W', sgn*(tp-entry)/risk, m
        if be and sgn*(fav-entry)>=be*risk: cur=entry
    m=min(len(bars),k+maxbars)-1
    return 'O', sgn*(bars[m][4]-entry)/risk, m
def confirm_bar(side, k, lo, hi, inv):
    # approx of genxConfirm on the closed bar k
    t,o,h,l,c=bars[k]; rng=max(h-l,1e-9); body=abs(c-o)/rng>=0.4; buf=max((hi-lo)*0.15,0.2)
    prev=bars[max(0,k-5):k]
    if side=='sell':
        tested = h>=lo-buf or (len(prev)>=1 and prev[-1][2]>=lo-buf)
        if c<o and body and tested and c<=hi+buf and c<inv: return True
        swept = any(p[2]>=lo-buf for p in prev[-3:]) or h>=lo-buf
        if swept and c<o and body and c<hi+buf and c<inv: return True
        # momentum: strong red close below prior 4 lows, not extended
        pl=min(p[3] for p in prev) if prev else l
        if c<o and (h-c)/rng>=0.55 and c<pl and c<inv and c>=lo-1.5*abs(inv-lo): return True
    else:
        tested = l<=hi+buf or (len(prev)>=1 and prev[-1][3]<=hi+buf)
        if c>o and body and tested and c>=lo-buf and c>inv: return True
        swept = any(p[3]<=hi+buf for p in prev[-3:]) or l<=hi+buf
        if swept and c>o and body and c>lo-buf and c>inv: return True
        ph=max(p[2] for p in prev) if prev else h
        if c>o and (c-l)/rng>=0.55 and c>ph and c>inv and c<=hi+1.5*abs(hi-inv): return True
    return False
def simulate(sigs, rule='touch', filt=None, stopmode=None, tpR=None, be=None, expire_h=8, one_at_a_time=False, same_usd=6):
    trades=[]; active=[]  # forming alerts
    busy_until=-1
    open_zones=[]  # (side, lo, hi, created, resolve_idx)
    for s in sigs:
        i=bisect.bisect_left(BT, s['t']-300)  # index of the bar that just closed
        if i>=len(bars)-2: continue
        side=s['side']; lo,hi=sorted([float(s['lo']),float(s['hi'])]); stop=float(s['stop']); tp=s['tp1']
        if tp is None: continue
        tp=float(tp); inv=float(s['inv'] or stop)
        # same-setup dedupe: an open (forming or unresolved) alert on this side within 6$ in last 4h
        open_zones=[z for z in open_zones if z[4]>=i and s['t']-z[3]<4*3600]
        if any(z[0]==side and abs((z[1]+z[2])/2-(lo+hi)/2)<=same_usd for z in open_zones): continue
        if filt and not filt(s,i): continue
        entry=None; k=None
        if s['st']=='TRADE_READY':
            entry=bars[i][4]; k=i+1
        else:
            buf=max((hi-lo)*0.15,0.2)
            for q in range(i+1, min(len(bars), i+1+expire_h*12)):
                t,o,h,l,c=bars[q]
                # invalidation on close
                if (side=='sell' and c>inv) or (side=='buy' and c<inv): break
                if rule=='touch':
                    if (side=='sell' and h>=lo-buf) or (side=='buy' and l<=hi+buf):
                        e=min(max(o,lo),hi) if side=='sell' else max(min(o,hi),lo)
                        rr=abs(tp-e)/max(abs(e-stop),1e-9)
                        if rr>=0.75: entry=e; k=q; break
                if confirm_bar(side,q,lo,hi,inv):
                    e=c; rr=abs(tp-e)/max(abs(e-stop),1e-9)
                    if (side=='sell' and e>tp) or (side=='buy' and e<tp):
                        if rr>=0.75: entry=e; k=q+1; break
                        # chased: wait 1 bar for pullback into zone
                        if q+1<len(bars):
                            nb=bars[q+1]
                            if (side=='sell' and nb[2]>=lo) or (side=='buy' and nb[3]<=hi):
                                entry=lo if side=='sell' else hi; k=q+1; break
                    break
        if entry is None:
            open_zones.append((side,lo,hi,s['t'],i+expire_h*12)); continue
        if one_at_a_time and k<=busy_until: continue
        st_=stop
        if stopmode:
            a=atr5(k-1); risk=max(abs(entry-stop), stopmode*a)
            st_=entry+risk if side=='sell' else entry-risk
        tp_=tp
        if tpR: 
            risk=abs(entry-st_); tp_=entry-tpR*risk if side=='sell' else entry+tpR*risk
        if (side=='sell' and not (tp_<entry<st_)) or (side=='buy' and not (tp_>entry>st_)): continue
        res,R,end=grade(k, side, entry, st_, tp_, be=be)
        busy_until=end
        open_zones.append((side,lo,hi,s['t'],end))
        trades.append(dict(t=s['t'],side=side,R=R,res=res,risk=abs(entry-st_),st=s['st'],session=s['session'],regime=s['regime'],conf=s['conf'],profile=s['profile'],setup=s['setup'],i=i))
    return trades
def summary(tr, by='month'):
    g=collections.OrderedDict()
    for x in tr:
        key=datetime.datetime.utcfromtimestamp(x['t']).strftime('%Y-%m') if by=='month' else x[by]
        g.setdefault(key,[]).append(x)
    return g
def line(tr):
    n=len(tr); 
    if not n: return 'n=0'
    w=sum(x['res']=='W' for x in tr); R=sum(x['R'] for x in tr)
    return f"n={n:4d} win%={100*w/n:3.0f} R={R:+7.1f} R/tr={R/n:+.2f}"
