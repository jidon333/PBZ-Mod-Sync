"""Prepare/apply bounded current-slot item counts, optionally including both reforge talismans."""
from pathlib import Path
import argparse, copy, datetime, hashlib, json, os, shutil, sys
from inspect_save import ROOT, GAME, SAVE, inspect
from pbz_editor.core import LosslessJSON, _game_processes

ITEM = 'Item_Traversing'
BASE = ['Inventory', 'InventoryInfos', ITEM]
SEOUL = datetime.timezone(datetime.timedelta(hours=9))

def now():
    return datetime.datetime.now(SEOUL)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def closed():
    pids = _game_processes(GAME)
    if pids:
        raise RuntimeError(f'Game is still running ({pids}); no live save was changed.')

def differences(a, b, path=()):
    if type(a) is not type(b):
        return [('/'.join(path), a, b)]
    if isinstance(a, dict):
        if a.keys() != b.keys():
            raise ValueError('Unexpected object member change at ' + '/'.join(path))
        return sum((differences(a[k], b[k], path + (k,)) for k in a), [])
    if isinstance(a, list):
        if len(a) != len(b):
            raise ValueError('Unexpected list length change')
        return sum((differences(x, y, path + (str(i),)) for i, (x, y) in enumerate(zip(a,b))), [])
    return [] if a == b else [('/'.join(path), a, b)]

def prepare(source, stamp, include_reforge=False):
    container, entries, report = inspect(source)
    slot = report['current_slot']
    matches = [e for e in entries if e['name'] == slot]
    if len(matches) != 1 or slot.startswith('__'):
        raise ValueError('No unambiguous current gameplay slot')
    selected = matches[0]
    items = [ITEM] + (['Return_Weapon_1', 'Return_ShaqiWeapon_1'] if include_reforge else [])
    editor = LosslessJSON(selected['raw'])
    expected = copy.deepcopy(selected['json'])
    edits = []
    records = {}
    # Keep every unrelated JSON byte intact, including numeric literals.
    for item in items:
        base = ['Inventory', 'InventoryInfos', item]
        record = selected['json']['Inventory']['InventoryInfos'][item]
        for key in ('CurrentAmount','MaxAmount'):
            if type(record[key]) is not int or not 0 <= record[key] <= 2147483647:
                raise ValueError('Unsupported item quantity schema')
        if record['CurrentAmount'] >= 99:
            raise ValueError(f'{item} already has at least 99; refusing to reduce or repeat')
        if not isinstance(record['DirtyTime'], str):
            raise ValueError('Unexpected item timestamp type')
        desired = {'CurrentAmount':99, 'MaxAmount':max(record['MaxAmount'],99), 'DirtyTime':stamp}
        for field, value in desired.items():
            edits.append((base + [field], value))
            editor.set(base + [field], value)
        expected['Inventory']['InventoryInfos'][item].update(desired)
        records[item] = {'before':record, 'after':expected['Inventory']['InventoryInfos'][item]}
    edited_raw = editor.bytes()
    assert json.loads(edited_raw) == expected
    # Explicit span reconstruction is independent of the editor's mutation loop.
    spans = LosslessJSON(selected['raw'])
    text = spans.text
    changes = []
    for path, value in edits:
        node = spans.node(path)
        changes.append((node.start, node.end, json.dumps(value, ensure_ascii=False, separators=(',',':'))))
    for start, end, replacement in sorted(changes, reverse=True):
        text = text[:start] + replacement + text[end:]
    assert edited_raw == text.encode('utf8'), 'Unrelated JSON bytes changed'
    encoded = container.encode(entries, {slot:edited_raw}, compression='preserve')
    decoded = container.decode(encoded)
    assert [e['name'] for e in entries] == [e['name'] for e in decoded]
    for old, new in zip(entries, decoded):
        assert old['algorithm'] == new['algorithm']
        if old['name'] == slot:
            assert new['raw'] == edited_raw and new['json'] == expected
        else:
            assert old['block'] == new['block'] and old['raw'] == new['raw']
    diffs = differences(selected['json'], expected)
    allowed = {'/'.join(path) for path, value in edits}
    assert {d[0] for d in diffs} <= allowed
    # The seal must detect a changed ciphertext byte rather than accept corruption.
    damaged = bytearray(encoded)
    damaged[-1] ^= 1
    try:
        container.decode(bytes(damaged))
    except ValueError:
        pass
    else:
        raise AssertionError('Authentication failed to reject corruption')
    return encoded, {
        'slot':slot, 'items':records,
        'diff':diffs, 'source_sha256':digest(source), 'candidate_sha256':digest(encoded),
        'source_bytes':len(source), 'candidate_bytes':len(encoded),
        'slot_count':len(entries), 'untouched_slots_byte_identical':len(entries)-1,
        'unrelated_selected_slot_bytes_preserved':True, 'roundtrip_authenticated':True,
        'corruption_rejected':True, 'runtime_verified':False,
        'compatibility':report['compatibility']}

def main():
    global GAME, SAVE
    if not __debug__: raise RuntimeError("Run without Python -O; validation assertions are required")
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--game', required=True, type=Path)
    p.add_argument('--save', type=Path, help='Explicit save when multiple accounts exist')
    p.add_argument('--apply', action='store_true')
    p.add_argument('--include-reforge', action='store_true', help='Also set existing weapon and phantom reset talismans to 99')
    args = p.parse_args()
    import inspect_save
    GAME, SAVE = inspect_save.configure(args.game, args.save)
    if args.apply:
        closed()
    source = SAVE.read_bytes()
    encoded, report = prepare(source, now().strftime('%Y.%m.%d-%H.%M.%S'), args.include_reforge)
    run = ROOT / ('apply-' if args.apply else 'preview-') / now().strftime('%Y%m%d-%H%M%S-%f')
    run.mkdir(parents=True, exist_ok=False)
    candidate = run / 'candidate.sav'
    candidate.write_bytes(encoded)
    (run / 'source.sav').write_bytes(source)
    report.update(status='preview-verified', save=str(SAVE), created=now().isoformat())
    receipt = run / 'receipt.json'
    def write_receipt():
        receipt.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    write_receipt()
    if args.apply:
        closed()
        assert SAVE.read_bytes() == source, 'Save changed during preparation'
        backup = run / 'backup'
        account_backup = backup / SAVE.parent.name
        shutil.copytree(SAVE.parent, account_backup)
        local_backup = backup / 'local-settings'
        local_backup.mkdir()
        for src in (GAME / 'ProjectPBZ/Saved').glob('*.sav'):
            shutil.copy2(src, local_backup / src.name)
        backup_files = []
        for src in SAVE.parent.rglob('*'):
            if src.is_file():
                dst = account_backup / src.relative_to(SAVE.parent)
                assert digest(src.read_bytes()) == digest(dst.read_bytes()), 'Backup mismatch'
                backup_files.append({'path':str(src.relative_to(SAVE.parent)), 'sha256':digest(dst.read_bytes())})
        assert (account_backup / SAVE.name).read_bytes() == source
        report.update(backup=str(backup), backup_files=backup_files, status='backed-up')
        write_receipt()
        closed()
        assert SAVE.read_bytes() == source, 'Live save changed before commit'
        temporary = SAVE.with_name('PBZSaveGame.traversal-99.tmp')
        with temporary.open('xb') as f:
            f.write(encoded)
            f.flush()
            os.fsync(f.fileno())
        closed()
        assert SAVE.read_bytes() == source, 'Live save changed at commit'
        os.replace(temporary, SAVE)
        assert SAVE.read_bytes() == encoded, 'Installed bytes mismatch'
        report.update(status='applied-file-verified', applied=now().isoformat())
        write_receipt()
    print(json.dumps({k:report[k] for k in ('status','slot','items','diff','roundtrip_authenticated','untouched_slots_byte_identical','runtime_verified')}, ensure_ascii=False, indent=2))
    print('RECEIPT:', receipt)

if __name__ == '__main__':
    main()
