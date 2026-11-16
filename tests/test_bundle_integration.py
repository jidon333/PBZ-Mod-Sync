"""Install the real packaged bytes in a disposable game fixture, never execute them."""
import importlib.util,json,shutil,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('bundle_sync',Path(__file__).resolve().parents[1]/'tools/mod_sync.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class BundleIntegration(unittest.TestCase):
    def test_real_bundle_install_export_restore(self):
        repo=m.ROOT
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);copy=root/'repo';game=root/'game'
            for relative in ('bundle.lock.json','dist/hid.dll','scripts/boot.js','settings/JidonPBZ.json'):
                dest=copy/relative;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(repo/relative,dest)
            (game/'platform/steam').mkdir(parents=True);(game/'platform/steam/PBZ.exe').write_bytes(b'fixture-only')
            (game/'ProjectPBZ').mkdir();(copy/'native').mkdir()
            (copy/'native/game-build.json').write_text(json.dumps({'sha256':m.sha(b'fixture-only')}),encoding='utf8')
            with patch.object(m,'ROOT',copy),patch.object(m,'ensure_closed',lambda:None):
                def call(action,*extra):
                    with patch.object(sys,'argv',['mod_sync.py',action,'--game',str(game),*extra]):m.main()
                call('install')
                self.assertFalse((game/'platform/steam/hid.dll').exists())
                call('install','--apply');call('verify')
                self.assertEqual((game/'platform/steam/hid.dll').read_bytes(),(repo/'dist/hid.dll').read_bytes())
                config=game/'ProjectPBZ/Content/JidonPBZ.json'
                original=config.read_bytes();new=json.loads(original);new['deflect']=1.5
                config.write_text(json.dumps(new),encoding='utf8');call('export','--apply')
                self.assertEqual(json.loads((copy/'settings/JidonPBZ.json').read_text())['deflect'],1.5)
                receipt=next((copy/'.local/backups').glob('*/receipt.json'))
                with self.assertRaises(ValueError):m.restore(game,receipt,True)
                config.write_bytes(original);m.restore(game,receipt,True)
                self.assertFalse((game/'platform/steam/hid.dll').exists())
                self.assertTrue((game/'platform/steam/PBZ.exe').exists())

if __name__=='__main__':unittest.main()
