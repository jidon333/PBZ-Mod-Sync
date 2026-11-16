"""Generate forwarding stubs and compile-time allowlist from auditable inputs."""
from pathlib import Path
import json,sys
root=Path(__file__).resolve().parents[1]
profile=json.loads((root/'native/game-build.json').read_text())
exports=json.loads((root/'native/hid-exports.json').read_text())
script=(root/'scripts/boot.js').read_bytes()
assert script.isascii() and b'\x00' not in script and len(exports)==47 and len(profile['calls'])==6
header='#pragma once\n'
header+='static const char* kExports[] = {'+','.join(json.dumps(s) for s in exports)+'};\n'
header+='static const unsigned char kGameHash[] = {'+','.join(str(v) for v in bytes.fromhex(profile['sha256']))+'};\n'
header+=f'static const unsigned kImageSize={profile["image_size"]}, kTimestamp={profile["timestamp"]};\n'
header+='struct Call { unsigned rva,target; unsigned char expected[8]; };\nstatic const Call kCalls[] = {\n'
for c in profile['calls']:header+='{'+f'{c["rva"]},{c["target"]},'+ '{'+','.join(str(v) for v in bytes.fromhex(c['bytes']))+'}},\n'
header+='};\nstatic const char kScript[] =\n'
# MSVC limits an individual raw string literal. Adjacent literals preserve the
# exact bytes while allowing a larger, still narrowly pinned bootstrap.
text=script.decode('ascii')
assert ')JIDON_SCRIPT"' not in text
header+='\n'.join('R"JIDON_SCRIPT('+text[i:i+8000]+')JIDON_SCRIPT"' for i in range(0,len(text),8000))+';\n'
(root/'native/generated.h').write_text(header,encoding='ascii')
asm='EXTERN hid_targets:QWORD\nEXTERN resolve_hid:PROC\n.code\n'
for i,name in enumerate(exports):
 asm+=f'proxy_{i} PROC FRAME\n sub rsp, 0A8h\n .allocstack 0A8h\n .endprolog\n'
 for reg,off in [('rcx',32),('rdx',40),('r8',48),('r9',56)]:asm+=f' mov [rsp+{off}], {reg}\n'
 for x in range(4):asm+=f' movdqu [rsp+{64+x*16}], xmm{x}\n'
 asm+=' call resolve_hid\n'
 for reg,off in [('rcx',32),('rdx',40),('r8',48),('r9',56)]:asm+=f' mov {reg}, [rsp+{off}]\n'
 for x in range(4):asm+=f' movdqu xmm{x}, [rsp+{64+x*16}]\n'
 asm+=f' add rsp, 0A8h\n jmp QWORD PTR [hid_targets+{i*8}]\nproxy_{i} ENDP\n'
asm+='END\n'
(root/'native/forward.asm').write_text(asm,encoding='ascii')
(root/'native/exports.def').write_text('LIBRARY hid\nEXPORTS\n'+''.join(f' {n}=proxy_{i}\n' for i,n in enumerate(exports)),encoding='ascii')
print('Generated ABI forwarders and exact-script allowlist.')
