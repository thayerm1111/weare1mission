from agrade import *
def grade_m(k, side, entry, stop, tp, maxbars, be=None, partial=None):
    sg=-1 if side=='sell' else 1; risk=abs(entry-stop); cur=stop; banked=0.0; rem=1.0
    for m in range(k, min(len(bars), k+maxbars)):
        t,o,h,l,c=bars[m]
        adv = h if side=='sell' else l; fav = l if side=='sell' else h
        if (side=='sell' and adv>=cur) or (side=='buy' and adv<=cur): return ('L' if cur==stop else 'S'), banked+rem*sg*(cur-entry)/risk, m
        if (side=='sell' and fav<=tp) or (side=='buy' and fav>=tp): return 'W', banked+rem*sg*(tp-entry)/risk, m
        if partial and rem==1.0 and sg*(fav-entry)>=partial*risk: banked+=0.5*partial; rem=0.5; cur=entry
        if be and sg*(fav-entry)>=be*risk: cur=entry
    m=min(len(bars),k+maxbars)-1
    return 'O', banked+rem*sg*(bars[m][4]-entry)/risk, m
import agrade
for name,kw in [('BE at 1R',dict(be=1.0)),('BE at 0.7R',dict(be=0.7)),('half off at 1R + BE',dict(partial=1.0))]:
    agrade.grade=lambda k,side,entry,stop,tp,mb,kw=kw: grade_m(k,side,entry,stop,tp,mb,**kw)
    show('new rule, '+name, run()); show('old rule, '+name, run(lambda s: not s['relaxed']))
    show('breakout_retest only, '+name, run(lambda s: s['strategy']=='breakout_retest'))
