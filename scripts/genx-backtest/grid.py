from feats2 import *
sigs=load_sigs()
FS={}
for s in sigs:
    i=bisect.bisect_left(BT, s['t']-300); FS[s['t'],s['side']]=feats(s,i)
cut=1757462400
def ev(name, filt=None, **kw):
    tr=simulate(sigs,'touch',filt=filt,**kw)
    a=[x for x in tr if x['t']<cut]; b=[x for x in tr if x['t']>=cut]
    q={}
    for x in tr: q.setdefault(datetime.datetime.utcfromtimestamp(x['t']).strftime('%y')+'Q'+str((datetime.datetime.utcfromtimestamp(x['t']).month-1)//3+1),[]).append(x['R'])
    pos=sum(1 for v in q.values() if sum(v)>0)
    print(f'{name:48s} TRAIN {line(a)} | TEST {line(b)} | +quarters {pos}/{len(q)}')
    return tr
F=lambda f: (lambda s,i: f(s,FS[s['t'],s['side']]))
ev('baseline')
ev('core only', F(lambda s,f: s['profile']=='core'))
ev('slope20>0', F(lambda s,f: f['slope20']>0))
ev('stack aligned', F(lambda s,f: f['stack']>0))
ev('above200 aligned', F(lambda s,f: f['above200']>0))
ev('rp24 0.3-0.8', F(lambda s,f: 0.3<=f['rp24']<=0.8))
ev('rp24 <0.8', F(lambda s,f: f['rp24']<0.8))
ev('no NY/off', F(lambda s,f: s['session'] not in ('New York','Off-session')))
ev('conf>=72', F(lambda s,f: (s['conf'] or 0)>=72))
ev('stack+core', F(lambda s,f: f['stack']>0 and s['profile']=='core'))
ev('stack+rp<0.8', F(lambda s,f: f['stack']>0 and f['rp24']<0.8))
ev('stack+core+rp<0.8', F(lambda s,f: f['stack']>0 and s['profile']=='core' and f['rp24']<0.8))
ev('baseline tp1.5R', tpR=1.5)
ev('baseline tp1R', tpR=1.0)
ev('baseline BE1R', be=1.0)
ev('baseline stop>=2.5ATR', stopmode=2.5)
ev('stack tp1.5R', F(lambda s,f: f['stack']>0), tpR=1.5)
ev('stack BE1R', F(lambda s,f: f['stack']>0), be=1.0)
ev('stack stop>=2.5ATR', F(lambda s,f: f['stack']>0), stopmode=2.5)
