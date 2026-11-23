"""TEST ONLY: execute the actual generated preflight with a TempFS root and explicitly mocked hardware/code identity.
No production bypass is added. Relative paths, scans, bounds and marker code are unmodified.
"""
import ast,hashlib,json,os,shlex,stat,sys,types,uuid
from pathlib import Path
args=json.load(sys.stdin);target=args['target'];root=Path(args['root']).resolve()
argv=shlex.split(args['command']);assert argv[:4]==[target['python'],'-B','-I','-c']
source=ast.parse(argv[4]);assigned=0
for node in source.body:
 if isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and node.targets[0].id=='r':
  assert isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id=='Path' and node.value.args[0].value==target['remoteRoot']
  node.value.args[0]=ast.Constant(str(root));assigned+=1
assert assigned==1
module=types.ModuleType('target_config')
module.load_target=lambda:types.SimpleNamespace(profile=target['profile'],root=target['remoteRoot'],catalog_sha256=target['catalogSha256'],identity=target['targetIdentity'],identity_label=target['identityLabel'],image=target['image'],bdfs={int(d['render'].split('renderD')[1]):d['bdf'] for d in target['devices']})
sys.modules['target_config']=module
# Windows lacks the Linux open flag; emulate rejection of links for this pure metadata fixture only.
os.O_NOFOLLOW=getattr(os,'O_NOFOLLOW',0)
real_open=os.open
def fixture_open(p,flags,*a,**kw):
 assert not Path(p).is_symlink(), 'fixture nofollow rejected a link'
 return real_open(p,flags,*a,**kw)
os.open=fixture_open
real_sha256=hashlib.sha256
fixture_hashes={('FIXTURE_METADATA:'+n).encode():h for n,h in target['codeSha256'].items()}
def fixture_sha256(data=b'',*a,**kw):
 if data in fixture_hashes:return types.SimpleNamespace(hexdigest=lambda:fixture_hashes[data])
 return real_sha256(data,*a,**kw)
hashlib.sha256=fixture_sha256
def audit(event,a):
 if event=='open':
  p=Path(a[0]).resolve();assert p.is_relative_to(root), 'test preflight attempted access outside TempFS'
  assert not (a[2] & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC)), 'test preflight attempted a write'
sys.addaudithook(audit)
exec(compile(ast.fix_missing_locations(source),'<actual-generated-preflight>','exec'),{})
