import life, glob, json
_orig=life.load_sigs
def load_i():
    s=[]
    for f in sorted(glob.glob('/tmp/claude-0/bt/isig_[0-9].jsonl')):
        for line in open(f):
            if line.strip(): s.append(json.loads(line))
    import datetime as _d
    def open_(t):
        d=_d.datetime.utcfromtimestamp(t); wd=d.weekday(); h=d.hour
        return not (wd==5 or (wd==4 and h>=21) or (wd==6 and h<22))
    s=[x for x in s if open_(x['t'])]; s.sort(key=lambda x:x['t']); return s
life.load_sigs=load_i
import feats2, datetime, bisect
from life import bars
H={}
for t,o,h,l,c in bars:
    d=datetime.datetime.utcfromtimestamp(t); wd=d.weekday()
    if not (wd==5 or (wd==4 and d.hour>=21) or (wd==6 and d.hour<22)): H[t//3600]=c
feats2.hk=sorted(H); feats2.hc=[H[k] for k in feats2.hk]
feats2.e20=feats2.ema(feats2.hc,20); feats2.e50=feats2.ema(feats2.hc,50); feats2.e200=feats2.ema(feats2.hc,200)
from life import simulate, line, BT
sigs=load_i(); print('intraday signals', len(sigs))
FS={}
for s in sigs:
    i=bisect.bisect_left(BT, s['t']-300); FS[s['t'],s['side']]=feats2.feats(s,i)
cut=1757462400
def ev(name, filt=None, rule='confirm', **kw):
    tr=simulate(sigs,rule,filt=filt,expire_h=12,**kw)
    a=[x for x in tr if x['t']<cut]; b=[x for x in tr if x['t']>=cut]
    q={}
    for x in tr: q.setdefault(datetime.datetime.utcfromtimestamp(x['t']).strftime('%y')+'Q'+str((datetime.datetime.utcfromtimestamp(x['t']).month-1)//3+1),[]).append(x['R'])
    pos=sum(1 for v in q.values() if sum(v)>0)
    rec=[x for x in tr if x['t']>=1789503060]
    print(f'{name:30s} TRAIN {line(a)} | TEST {line(b)} | +q {pos}/{len(q)} | since09-11 {line(rec)}')
F=lambda f: (lambda s,i: f(s,FS[s['t'],s['side']]))
ev('intraday baseline (confirm)')
ev('intraday baseline (touch)', rule='touch')
ev('stack', F(lambda s,f: f['stack']>0))
ev('core', F(lambda s,f: s['profile']=='core'))
ev('stack+core', F(lambda s,f: f['stack']>0 and s['profile']=='core'))
ev('stack+core touch', F(lambda s,f: f['stack']>0 and s['profile']=='core'), rule='touch')
