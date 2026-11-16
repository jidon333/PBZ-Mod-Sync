"""Install our source-built loader and explicitly sync its settings. Python 3.11+."""
from pathlib import Path, PurePosixPath
import argparse, datetime, hashlib, json, os, subprocess, tempfile

ROOT = Path(__file__).resolve().parents[1]
CONFIGS = ('JidonPBZ.json',)
CONFIG_DIR = 'ProjectPBZ/Content'

def sha(data): return hashlib.sha256(data).hexdigest()

def safe_path(root, relative):
    relative = relative.replace('\\', '/')
    path = PurePosixPath(relative)
    if path.is_absolute() or '..' in path.parts or ':' in relative:
        raise ValueError('Unsafe relative path')
    root = root.resolve()
    target = root.joinpath(*path.parts)
    if not target.resolve().is_relative_to(root):
        raise ValueError('Path escapes destination, possibly through a symlink')
    return target

def validate_game(game):
    game = game.resolve()
    if not (game/'platform/steam/PBZ.exe').is_file() or not (game/'ProjectPBZ').is_dir():
        raise ValueError('Choose the Steam PBZ folder containing ProjectPBZ and platform/steam/PBZ.exe')
    return game

def ensure_closed():
    if os.name != 'nt': raise RuntimeError('Applying changes requires Windows')
    command = "@(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -like 'PBZ*' }).Count"
    p = subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',command], capture_output=True, text=True)
    if p.returncode or p.stdout.strip() != '0':
        raise RuntimeError('Close Phantom Blade Zero first (or process check failed)')

def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.pbz-sync-', dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name): os.unlink(name)

def read_lock():
    return json.loads((ROOT/'bundle.lock.json').read_text(encoding='utf8'))

def bundle_payload(lock):
    result = {}
    allowed={'platform/steam/hid.dll','ProjectPBZ/Content/JavaScript/JidonPBZ/boot.js'}
    for package in lock['packages']:
        for entry in package['files']:
            if entry['path'] not in allowed or entry['path'] in result:
                raise ValueError('Unexpected or duplicate bundle destination')
            source=safe_path(ROOT,entry['source'])
            if source.stat().st_size>2*1024*1024:raise ValueError('Unexpected bundle size')
            data=source.read_bytes()
            if sha(data)!=entry['sha256']:raise ValueError('Bundle integrity mismatch')
            result[entry['path']]=data
    if set(result)!=allowed:raise ValueError('Incomplete bundle')
    return result

def commit_files(game, payload, action, apply=False):
    plan = []
    for rel,data in payload.items():
        target = safe_path(game,rel)
        old = target.read_bytes() if target.exists() else None
        if old != data:
            plan.append((rel,old,data))
    print(json.dumps({'action':action,'apply':apply,'changes':[p[0] for p in plan]},indent=2))
    if not apply or not plan: return None
    ensure_closed()
    run = ROOT/'.local/backups'/datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    run.mkdir(parents=True,exist_ok=False)
    receipt = {'game':str(game),'action':action,'status':'prepared','files':[]}
    for rel,old,data in plan:
        if old is not None: atomic_write(safe_path(run/'original',rel),old)
        receipt['files'].append({'path':rel,'before_sha256':None if old is None else sha(old),'after_sha256':sha(data)})
    receipt_path=run/'receipt.json'
    def record(): atomic_write(receipt_path,json.dumps(receipt,indent=2).encode('utf8'))
    record()
    written=[]
    try:
        for rel,old,data in plan:
            ensure_closed()
            target=safe_path(game,rel)
            current=target.read_bytes() if target.exists() else None
            if current != old: raise RuntimeError('File changed since preview: '+rel)
            atomic_write(target,data); written.append((target,old,data))
            if target.read_bytes()!=data: raise RuntimeError('Write verification failed')
        receipt['status']='applied-file-verified'; record()
    except Exception:
        for target,old,data in reversed(written):
            if target.read_bytes()!=data: continue
            if old is None: target.unlink()
            else: atomic_write(target,old)
        receipt['status']='failed-rollback-attempted'; record(); raise
    print('BACKUP:',receipt_path)
    return receipt_path

def verify_installed(game, lock):
    failures=[]
    for package in lock['packages']:
        for f in package['files']:
            path=safe_path(game,f['path'])
            if not path.is_file() or sha(path.read_bytes())!=f['sha256']: failures.append(f['path'])
    if failures: raise ValueError('Missing or changed mod files: '+', '.join(failures))

def restore(game, receipt_path, apply):
    receipt_path=receipt_path.resolve()
    if not receipt_path.is_relative_to((ROOT/'.local/backups').resolve()): raise ValueError('Receipt must be in this checkout .local/backups')
    receipt=json.loads(receipt_path.read_text(encoding='utf8'))
    if Path(receipt['game']).resolve()!=game: raise ValueError('Receipt belongs to another game folder')
    payload={}; removes=[]
    for entry in receipt['files']:
        target=safe_path(game,entry['path'])
        if not target.is_file() or sha(target.read_bytes())!=entry['after_sha256']:
            raise ValueError('Installed file changed; refusing to overwrite newer work: '+entry['path'])
        if entry['before_sha256'] is None: removes.append((target,entry['after_sha256']))
        else:
            data=safe_path(receipt_path.parent/'original',entry['path']).read_bytes()
            if sha(data)!=entry['before_sha256']: raise ValueError('Backup hash mismatch')
            payload[entry['path']]=data
    print('RESTORE removes:',[str(p) for p,h in removes])
    commit_files(game,payload,'restore',apply)
    if apply:
        for target,h in removes:
            ensure_closed()
            if sha(target.read_bytes())!=h: raise ValueError('File changed during restore')
            target.unlink()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['install','settings','export','verify','restore'])
    p.add_argument('--game',required=True,type=Path)
    p.add_argument('--receipt',type=Path)
    p.add_argument('--apply',action='store_true',help='Without this, only preview changes')
    args=p.parse_args();game=validate_game(args.game);lock=read_lock()
    if args.action=='restore':
        if args.receipt is None:p.error('--receipt required')
        restore(game,args.receipt,args.apply);return
    if args.action in ('verify','settings','export'): verify_installed(game,lock)
    if args.action=='verify':
        print('Pinned mod files verified; settings:')
        for name in CONFIGS:
            src=safe_path(game,CONFIG_DIR+'/'+name)
            print(name,'MATCH' if src.is_file() and src.read_bytes()==(ROOT/'settings'/name).read_bytes() else 'DIFFERENT/MISSING')
        return
    if args.action=='export':
        ensure_closed()
        payload={name:safe_path(game,CONFIG_DIR+'/'+name).read_bytes() for name in CONFIGS}
        # Configs are text only. Prevent accidentally exporting oversized/binary files.
        for name,data in payload.items():
            if len(data)>65536 or b'\x00' in data: raise ValueError('Unexpected config')
            data.decode('utf-8-sig')
            print(name,sha(data))
        if args.apply:
            for name,data in payload.items():atomic_write(ROOT/'settings'/name,data)
        print('Review git diff, then commit/push explicitly.');return
    payload={}
    if args.action=='install':
        profile=json.loads((ROOT/'native/game-build.json').read_text(encoding='utf8'))
        if sha((game/'platform/steam/PBZ.exe').read_bytes())!=profile['sha256']:
            raise ValueError('Unsupported game build; no files changed')
        payload=bundle_payload(lock)
        existing=game/'platform/steam/hid.dll'
        if existing.exists() and existing.read_bytes()!=payload['platform/steam/hid.dll']:
            raise ValueError('A different hid.dll is installed; isolate it before installing our loader')
        if (game/'ProjectPBZ/Content/JavaScript/PBZModsMenu').exists():
            raise ValueError('Original Mods Menu directory must be isolated first')
        for ext in ('pak','utoc','ucas'):
            if safe_path(game,CONFIG_DIR+'/Paks/~mods/zzz_PBZPerfectDefense_P.'+ext).exists():
                raise ValueError('Legacy PerfectDefense files detected; follow author uninstall instructions first')
    payload.update({CONFIG_DIR+'/'+name:(ROOT/'settings'/name).read_bytes() for name in CONFIGS})
    commit_files(game,payload,args.action,args.apply)

if __name__=='__main__':main()
