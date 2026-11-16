"""Private save inspection for the optional item supply command."""
from pathlib import Path
import hashlib, sys

BUNDLE = Path(__file__).resolve().parents[1]
ROOT = BUNDLE/'.local/item-supply'
GAME = SAVE = None
sys.path.insert(0,str(BUNDLE/'vendor/pbz-editor'))
from pbz_editor.core import PBZSContainer
from pbz_editor.compatibility import resolve_key
from pbz_editor.compression import OpenOodleCodec

def configure(game, save=None):
    global GAME,SAVE
    from mod_sync import validate_game
    GAME=validate_game(game)
    base=(GAME/'ProjectPBZ/Saved/SaveGames/Steam').resolve()
    if save is None:
        candidates=list(base.glob('*/PBZSaveGame.sav'))
        if len(candidates)!=1: raise ValueError('Select exactly one account save with --save')
        save=candidates[0]
    SAVE=save.resolve()
    if not SAVE.is_relative_to(base) or SAVE.name!='PBZSaveGame.sav' or not SAVE.is_file():
        raise ValueError('Save must be an existing PBZSaveGame.sav under this game Steam save directory')
    return GAME,SAVE

def inspect(source):
    key,compatibility=resolve_key(GAME,source)
    native=BUNDLE/'.local/native'
    expected='cc98ce6cfe62d23cdaeaa350a5a011984e03582fb54ad466b970e741b721e179'
    if not (native/'pbz_codec.dll').is_file() or hashlib.sha256((native/'pbz_codec.dll').read_bytes()).hexdigest()!=expected:
        raise ValueError('Run tools/setup_save_tool.py to download the pinned open decoder first')
    container=PBZSContainer(key,OpenOodleCodec(native))
    entries=container.decode(source)
    current=next(e['json']['LastContinueSlot'] for e in entries if e['name']=='__Advanced__')
    return container,entries,{'current_slot':current,'compatibility':compatibility}
