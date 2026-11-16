"""Package the locally compiled own loader; never consumes third-party DLLs."""
from pathlib import Path
import hashlib,json,shutil
root=Path(__file__).resolve().parents[1]
source=root/'.local/build/hid.dll'
data=source.read_bytes()
if b'JidonPBZ source-built loader' not in data or len(data)>2*1024*1024:
    raise RuntimeError('Expected our compiled loader')
(root/'dist').mkdir(exist_ok=True)
shutil.copy2(source,root/'dist/hid.dll')
files=[]
for local,target in [('dist/hid.dll','platform/steam/hid.dll'),('scripts/boot.js','ProjectPBZ/Content/JavaScript/JidonPBZ/boot.js')]:
    files.append({'source':local,'path':target,'sha256':hashlib.sha256((root/local).read_bytes()).hexdigest()})
manifest={'version':'0.2.0-preview','packages':[{'id':'jidon-source-built','files':files}],
          'previous_bundles':json.loads((root/'native/previous-bundles.json').read_text(encoding='utf8'))}
(root/'bundle.lock.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8',newline='\n')
print(json.dumps(manifest,indent=2))
