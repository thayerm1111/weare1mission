import json,sys,glob,re
bars={}
for f in sorted(glob.glob(sys.argv[1])):
    txt=open(f).read()
    j=json.loads(txt)
    s=j['result'] if isinstance(j,dict) else j[0]['text']
    m=re.search(r'"enc":"([^"]*)"',s.replace('\\"','"'))
    enc=m.group(1)
    pm=0; pc=0  # each chunk starts absolute
    for tok in enc.split(';'):
        if not tok: continue
        dm,do,dh,dl,dc=map(int,tok.split(','))
        mm=pm+dm; o=pc+do; h=o+dh; l=o-dl; c=o+dc
        bars[mm]=[mm*60000,o/100,h/100,l/100,c/100]
        pm=mm; pc=c
out=[bars[k] for k in sorted(bars)]
json.dump(out,open(sys.argv[2],'w'))
print(len(out), out[0][0], out[-1][0])
