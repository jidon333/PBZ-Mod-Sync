import importlib.util, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('mod_sync',Path(__file__).resolve().parents[1]/'tools/mod_sync.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.game=self.root/'game';self.repo=self.root/'repo'
        (self.game/'platform/steam').mkdir(parents=True);(self.game/'platform/steam/PBZ.exe').write_bytes(b'fixture')
        (self.game/'ProjectPBZ').mkdir();self.repo.mkdir()
        self.patches=[patch.object(m,'ROOT',self.repo),patch.object(m,'ensure_closed',lambda:None)]
        for p in self.patches:p.start();self.addCleanup(p.stop)
    def test_preview_does_not_write(self):
        m.commit_files(self.game,{'new.txt':b'value'},'install')
        self.assertFalse((self.game/'new.txt').exists());self.assertFalse((self.repo/'.local').exists())
    def test_backup_install_and_restore(self):
        (self.game/'old.txt').write_bytes(b'before')
        (self.game/'unrelated.txt').write_bytes(b'preserve')
        receipt=m.commit_files(self.game,{'old.txt':b'after','new.txt':b'new'},'install',True)
        self.assertEqual((receipt.parent/'original/old.txt').read_bytes(),b'before')
        m.restore(self.game,receipt,True)
        self.assertEqual((self.game/'old.txt').read_bytes(),b'before');self.assertFalse((self.game/'new.txt').exists())
        self.assertEqual((self.game/'unrelated.txt').read_bytes(),b'preserve')
    def test_restore_preserves_newer_changes(self):
        receipt=m.commit_files(self.game,{'new.txt':b'new'},'install',True)
        (self.game/'new.txt').write_bytes(b'user-edit')
        with self.assertRaises(ValueError):m.restore(self.game,receipt,True)
        self.assertEqual((self.game/'new.txt').read_bytes(),b'user-edit')
    def test_process_guard_blocks_writes(self):
        with patch.object(m,'ensure_closed',side_effect=RuntimeError('running')):
            with self.assertRaises(RuntimeError):m.commit_files(self.game,{'new.txt':b'x'},'install',True)
        self.assertFalse((self.game/'new.txt').exists())
    def test_path_escape_rejected(self):
        for rel in ('../outside','/absolute','C:/outside','a/../../outside'):
            with self.assertRaises(ValueError):m.safe_path(self.game,rel)
    def test_bundle_integrity_and_destinations(self):
        (self.repo/'loader').write_bytes(b'fixture-dll');(self.repo/'script').write_bytes(b'fixture-js')
        entries=[{'source':'loader','path':'platform/steam/hid.dll','sha256':m.sha(b'fixture-dll')},
                 {'source':'script','path':'ProjectPBZ/Content/JavaScript/JidonPBZ/boot.js','sha256':m.sha(b'fixture-js')}]
        lock={'packages':[{'files':entries}]}
        self.assertEqual(len(m.bundle_payload(lock)),2)
        (self.repo/'loader').write_bytes(b'modified')
        with self.assertRaises(ValueError):m.bundle_payload(lock)
        (self.repo/'loader').write_bytes(b'fixture-dll');entries[0]['path']='unrelated.exe'
        with self.assertRaises(ValueError):m.bundle_payload(lock)
    def test_partial_install_rolls_back(self):
        (self.game/'old.txt').write_bytes(b'before');write=m.atomic_write
        def fail(path,data):
            if path==self.game/'fail.txt':raise OSError('injected failure')
            return write(path,data)
        with patch.object(m,'atomic_write',side_effect=fail):
            with self.assertRaises(OSError):m.commit_files(self.game,{'old.txt':b'after','fail.txt':b'x'},'install',True)
        self.assertEqual((self.game/'old.txt').read_bytes(),b'before')
    def test_settings_requires_exact_installed_mod(self):
        lock={'packages':[{'files':[{'path':'missing.js','sha256':'0'*64}]}]}
        with self.assertRaises(ValueError):m.verify_installed(self.game,lock)
    def test_upgrade_requires_complete_known_pair(self):
        paths={'platform/steam/hid.dll':b'our-old-dll','ProjectPBZ/Content/JavaScript/JidonPBZ/boot.js':b'our-old-script'}
        for p,data in paths.items():
            dest=self.game/p;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
        lock={'previous_bundles':[{'files':{p:m.sha(d) for p,d in paths.items()}}]}
        self.assertTrue(m.known_previous_bundle(self.game,lock,paths))
        (self.game/'platform/steam/hid.dll').write_bytes(b'unknown')
        self.assertFalse(m.known_previous_bundle(self.game,lock,paths))
        self.assertFalse(m.known_previous_bundle(self.game,{'previous_bundles':[{'files':{}}]},paths))

if __name__=='__main__':unittest.main()
