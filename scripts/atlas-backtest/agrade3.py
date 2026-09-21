import agrade
from agrade import *
import feats2, bisect as _b
import datetime as _d
H={}
for t,o,h,l,c in bars:
    d=_d.datetime.utcfromtimestamp(t); wd=d.weekday()
    if not (wd==5 or (wd==4 and d.hour>=21) or (wd==6 and d.hour<22)): H[t//3600]=c
feats2.hk=sorted(H); feats2.hc=[H[k] for k in feats2.hk]
feats2.e20=feats2.ema(feats2.hc,20); feats2.e50=feats2.ema(feats2.hc,50); feats2.e200=feats2.ema(feats2.hc,200)
def stack(s):
    t=s['t']//1000; i=_b.bisect_left(BT,t-300)
    return feats2.feats({'t':t,'side':s['side']}, i)['stack']>0
show('ATLAS old rule + 1h EMA stack', run(lambda s: not s['relaxed'] and stack(s)))
show('ATLAS new rule + 1h EMA stack', run(lambda s: stack(s)))
show('ATLAS old rule, stack, London+Asia', run(lambda s: not s['relaxed'] and stack(s) and s['session']!='new_york'))
