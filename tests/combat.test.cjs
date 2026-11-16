const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
function fixture() {
  let time=0,ms=1000,paused=false,dead=false,pawn={name:'player'},configText='';
  const entries=new Map([['other-mod',0.8]]),listeners=[];
  const sub={RuntimeSlomoData:{SlomoData:{GetMaxIndex:()=>entries.size,IsValidIndex:()=>true,GetKey:i=>[...entries.keys()][i]}},ApplySlomo:(k,v)=>{if(v===1)entries.delete(k);else entries.set(k,v);}};
  const cfg={'Deflect Perfect Window Frames':8,'Deflect Perfect Window Frames On Break':6};
  const dash={DurationMagnitude:{ScalableFloatMagnitude:{Value:0.2}}};
  const UE={KismetSystemLibrary:{GetProjectSavedDirectory:()=>'',GetProjectContentDirectory:()=>'',GetPathName:p=>p.name},
    EasyCsv:{SaveStringToFileWithFullPath:()=>true,LoadStringFromLocalFile:(p,r)=>{if(!configText)return false;r.v=configText;return true;}},
    GameplayTag:class{},GameplayStatics:{GetPlayerCharacter:()=>pawn,GetTimeSeconds:()=>time,IsGamePaused:()=>paused},
    AbilitySystemBlueprintLibrary:{GetAbilitySystemComponent:()=>({HasMatchingGameplayTag:t=>dead&&t.TagName==='CharacterState.Dead'})},
    PBZLevelSequenceManager:{StaticClass:()=> 'sequence'},SlomoWorldSubsystem:{StaticClass:()=> 'slow'},
    SubsystemBlueprintLibrary:{GetWorldSubsystem:(p,c)=>c==='slow'?sub:{IsInSequence:()=>false}},
    AbilityAsync_WaitGameplayEvent:{WaitGameplayEventToActor:()=>{const t={EventReceived:{Add:f=>t.callback=f},Activate(){},EndAction(){t.ended=true;}};listeners.push(t);return t;}},
    Object:{Find:p=>p.includes('_Normal.')?cfg:null},Class:{Load:()=> 'dash'},SGameAIFunctionLibrary:{GetClassDefaultObject:()=>dash}};
  const ctx=vm.createContext({require:n=>n==='ue'?UE:n==='puerts'?{argv:{getByName:()=>({})},$ref:v=>({v}),$unref:r=>r.v}:{},Date:class extends Date {static now(){return ms;}},setInterval:()=>1,console});
  vm.runInContext(fs.readFileSync('scripts/boot.js','utf8')+'\nglobalThis.api={tick,onAttack,state};',ctx);
  return {api:ctx.api,entries,cfg,dash,listeners,advance:(t,m)=>{time=t;ms=m;},pause:v=>paused=v,death:v=>dead=v,travel:()=>pawn={name:'new-world-player'},config:v=>configText=JSON.stringify(v)};
}
function attack(kind,hit=1){return {OptionalObject:{ReceiveFrame:{SourceAction:{DeflectType:kind},HitGameTime:hit,IsHit:false}}};}
let count=0;function test(name,fn){fn();console.log('PASS '+name);count++;}
test('scaling is stable across repeated ticks',()=>{const f=fixture();f.api.tick();assert.equal(f.cfg['Deflect Perfect Window Frames'],16);assert.equal(f.dash.DurationMagnitude.ScalableFloatMagnitude.Value,.4);f.advance(.1,2100);f.api.tick();assert.equal(f.cfg['Deflect Perfect Window Frames'],16);assert.equal(f.dash.DurationMagnitude.ScalableFloatMagnitude.Value,.4);});
for(const kind of [2,3])test('color '+kind+' starts and restores with time cap',()=>{const f=fixture();f.api.tick();f.api.onAttack(attack(kind));f.advance(.5,1500);f.api.tick();assert.equal(f.entries.get('JidonPBZ.Slow'),.5);f.advance(.6,3100);f.api.tick();assert(!f.entries.has('JidonPBZ.Slow'));assert.equal(f.entries.get('other-mod'),.8);});
for(const why of ['death','pause','travel'])test(why+' restores and clears pending',()=>{const f=fixture();f.api.tick();f.api.onAttack(attack(2));f.advance(.5,1500);f.api.tick();if(why==='travel')f.travel();else f[why](true);f.api.tick();assert(!f.entries.has('JidonPBZ.Slow'));assert.equal(f.api.state.pending,null);});
test('black attacks and expired warnings are ignored',()=>{const f=fixture();f.api.tick();f.api.onAttack(attack(4));f.api.onAttack(attack(2,-1));assert.equal(f.api.state.pending,null);});
test('successful deflect immediately restores only our slow key',()=>{const f=fixture();f.api.tick();f.api.onAttack(attack(2));f.advance(.5,1500);f.api.tick();assert(f.entries.has('JidonPBZ.Slow'));f.listeners[2].callback({});assert(!f.entries.has('JidonPBZ.Slow'));assert.equal(f.entries.get('other-mod'),.8);});
test('diagnostic does not pass when its blue timing was missed',()=>{const f=fixture();f.config({selfTest:true});f.api.tick();f.advance(4,5000);f.api.tick();assert.equal(f.api.state.selfTest,1);f.advance(6,7000);f.api.tick();assert.equal(f.api.state.selfTest,-1);});
test('disable restores both timing fields and only own slow key',()=>{const f=fixture();f.api.tick();f.api.onAttack(attack(3));f.advance(.5,1500);f.api.tick();f.config({enabled:false});f.advance(.6,2500);f.api.tick();assert.equal(f.cfg['Deflect Perfect Window Frames'],8);assert.equal(f.dash.DurationMagnitude.ScalableFloatMagnitude.Value,.2);assert(!f.entries.has('JidonPBZ.Slow'));assert.equal(f.entries.get('other-mod'),.8);});
test('invalid config stops slowdown without executing arbitrary code',()=>{const f=fixture();f.api.tick();f.api.onAttack(attack(2));f.advance(.5,1500);f.api.tick();f.config({speed:0});f.advance(.6,2500);f.api.tick();assert(!f.entries.has('JidonPBZ.Slow'));});
console.log(count+' behavior tests passed (mock engine; live tests separate).');
