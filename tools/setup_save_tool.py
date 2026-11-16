"""Fetch only the pinned open-source decoder, never execute the upstream editor."""
from pathlib import Path
import hashlib, io, urllib.request, zipfile
ROOT=Path(__file__).resolve().parents[1]
URL='https://github.com/qry6868/PBZ-Editor/releases/download/v0.3.0/PBZ-Editor-0.3.0-windows-x64.zip'
EXPECTED='8697b5ffec3586f56f466e9d8686777380af1e042c80b1220f4906cddcf702d5'
def main():
    with urllib.request.urlopen(URL,timeout=60) as response:
        data=response.read(64*1024*1024+1)
    if len(data)>64*1024*1024 or hashlib.sha256(data).hexdigest()!=EXPECTED:
        raise ValueError('Release hash mismatch; nothing installed')
    dest=ROOT/'.local/native';dest.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in ('pbz_codec.dll','manifest.json'):
            matches=[n for n in z.namelist() if n.endswith('/native/'+name)]
            if len(matches)!=1:raise ValueError('Unexpected release layout')
            (dest/name).write_bytes(z.read(matches[0]))
    print('Pinned decoder prepared in .local/native (excluded from Git).')
if __name__=='__main__':main()
