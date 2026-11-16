"use strict";
require("MainStart");
const UE = require("ue"), puerts = require("puerts");
const gi = puerts.argv.getByName("GameInstance");
const logPath = UE.KismetSystemLibrary.GetProjectSavedDirectory() + "JidonPBZ-runtime.log";
let lines = [];
function log(message) {
    lines.push(new Date().toISOString() + " " + message);
    if (lines.length > 500) lines.shift();
    UE.EasyCsv.SaveStringToFileWithFullPath(lines.join("\n") + "\n", logPath);
}
const configPath = UE.KismetSystemLibrary.GetProjectContentDirectory() + "JidonPBZ.json";
const defaults = { enabled: true, deflect: 2, dodge: 2, blue: true, red: true, speed: 0.5, seconds: 1.5, selfTest: false };
let config = Object.assign({}, defaults), configAt = 0, configText = "", lastReport = 0;
const key = "JidonPBZ.Slow", tag = (name) => { const t = new UE.GameplayTag(); t.TagName = name; return t; };
const clock = () => UE.GameplayStatics.GetTimeSeconds(gi);
const state = { pawn: null, path: "", listener: [], sub: null, pending: null, active: null, records: [], events: 0, blue: 0, red: 0, starts: 0, stops: 0, selfTest: 0, readyAt: 0, testStarts: 0, testStops: 0 };
const stopTags = ["CharacterState.Dead", "CharacterState.InLevelSequence", "CharacterState.Native.Sequence", "Ability.Action.Execution", "Ability.Executed", "CharacterState.HitReact.State.Executing"];
function hasKey(sub) {
    const map = sub.RuntimeSlomoData.SlomoData;
    for (let i = 0; i < map.GetMaxIndex(); i++) if (map.IsValidIndex(i) && String(map.GetKey(i)) === key) return true;
    return false;
}
function stop(reason) {
    state.pending = null;
    if (!state.active) return true;
    try {
        state.active.sub.ApplySlomo(key, 1);
        if (hasKey(state.active.sub)) { log("RESTORE_RETRY " + reason); return false; }
        state.active = null; state.stops++; log("SLOW_STOP " + reason + " key_removed=true"); return true;
    } catch (e) { log("RESTORE_ERROR " + reason + " " + e); return false; }
}
function start(hit, color, now) {
    if (!state.sub || state.active) return;
    // Record ownership before writing, so even a post-write exception enters cleanup.
    state.active = { sub: state.sub, hit, color, deadline: Date.now() + config.seconds * 1000, pawn: state.path };
    try {
        state.sub.ApplySlomo(key, config.speed);
        if (!hasKey(state.sub)) throw new Error("subsystem did not retain our key");
        state.starts++; log("SLOW_START " + color + " speed=" + config.speed + " hit=" + hit + " now=" + now);
    } catch (e) { log("SLOW_ERROR " + e); stop("start-error"); }
}
function blocked(pawn) {
    if (!config.enabled) return "disabled";
    if (!pawn) return "no-pawn";
    if (UE.GameplayStatics.IsGamePaused(gi)) return "pause";
    const asc = UE.AbilitySystemBlueprintLibrary.GetAbilitySystemComponent(pawn);
    if (asc) for (const t of stopTags) if (asc.HasMatchingGameplayTag(tag(t))) return t;
    const seq = UE.SubsystemBlueprintLibrary.GetWorldSubsystem(pawn, UE.PBZLevelSequenceManager.StaticClass());
    if (seq && seq.IsInSequence()) return "cutscene";
    return "";
}
function onAttack(data) {
    try {
        const frame = data.OptionalObject.ReceiveFrame, action = frame.SourceAction;
        const kind = typeof action.DeflectBulletType === "number" ? action.DeflectBulletType : action.DeflectType;
        state.events++;
        const color = kind === 2 ? "blue" : kind === 3 ? "red" : "";
        if (!color || !config[color] || blocked(state.pawn) || frame.IsHit) return;
        const now = clock(), hit = frame.HitGameTime;
        if (!Number.isFinite(hit) || hit <= now || hit - now > 10) return;
        state[color]++;
        // Keep the earliest pending hit; a later warning must not prolong an active slowdown.
        if (!state.active && (!state.pending || hit < state.pending.hit)) state.pending = { hit, color };
        log("ATTACK_EVENT " + color + " lead=" + (hit - now));
    } catch (e) { log("EVENT_ERROR " + e); }
}
function bind(pawn, path) {
    if (!stop("pawn-or-world-change")) return;
    for (const task of state.listener) try { task.EndAction(); } catch (_) { }
    state.listener = []; state.pawn = pawn; state.path = path; state.sub = null;
    if (!pawn) return;
    const sub = UE.SubsystemBlueprintLibrary.GetWorldSubsystem(pawn, UE.SlomoWorldSubsystem.StaticClass());
    hasKey(sub); state.sub = sub; state.readyAt = Date.now() + 3000;
    for (const name of ["GameplayEvent.Ability.Action.Deflect.Frame.Dodge.Defender", "GameplayEvent.Ability.Action.Deflect.Frame.Deflect.Defender"]) {
        const task = UE.AbilityAsync_WaitGameplayEvent.WaitGameplayEventToActor(pawn, tag(name), false, false);
        if (!task) throw new Error("event listener unavailable");
        task.EventReceived.Add(onAttack); task.Activate(); state.listener.push(task);
    }
    for (const name of ["GameplayEvent.Ability.Action.Deflect.Defender", "GameplayEvent.Actor.HitDodge.Target", "GameplayEvent.Ability.Action.PerfectDodge.Defender"]) {
        const task = UE.AbilityAsync_WaitGameplayEvent.WaitGameplayEventToActor(pawn, tag(name), false, false);
        if (!task) throw new Error("result listener unavailable");
        task.EventReceived.Add(() => stop("deflect-or-dodge-result")); task.Activate(); state.listener.push(task);
    }
    log("BOUND pawn=" + path + " event_listeners=" + state.listener.length);
}
function scale(object, field, multiplier, label, cap) {
    if (!object) return;
    const value = object[field]; if (typeof value !== "number" || !Number.isFinite(value)) return;
    let rec = state.records.find(r => r.object === object && r.field === field);
    if (!rec) { rec = { object, field, base: value, written: value }; state.records.push(rec); }
    if (value !== rec.written) rec.base = value;
    // Native deflect windows are integer frame counts, including odd baselines.
    const want = Math.min(cap, Math.round(rec.base * multiplier));
    if (value === want) return;
    object[field] = want; rec.written = object[field];
    if (rec.written !== want) throw new Error("write/readback mismatch " + label);
    log("WINDOW " + label + " base=" + rec.base + " actual=" + rec.written);
}
let dodgeBase, dodgeLast, dodgeObject;
function windows() {
    for (const level of ["Easy", "Handicapped", "Normal", "Hard", "Nightmare"]) {
        const object = UE.Object.Find("/PBZCombatAsset/Config/GlobalConfig_Combat_" + level + ".GlobalConfig_Combat_" + level);
        for (const field of ["Deflect Perfect Window Frames", "Deflect Perfect Window Frames On Break"])
            scale(object, field, config.enabled ? config.deflect : 1, level + "/" + field, 60);
    }
    const cls = UE.Class.Load("/PBZDeflectSystem/GameplayEffects/GE_PerfectDash.GE_PerfectDash_C");
    if (!cls) return;
    const object = UE.SGameAIFunctionLibrary.GetClassDefaultObject(cls);
    const magnitude = object.DurationMagnitude, flat = magnitude.ScalableFloatMagnitude, value = flat.Value;
    if (!Number.isFinite(value)) throw new Error("invalid dodge duration");
    if (dodgeObject !== object || value !== dodgeLast) dodgeBase = value;
    dodgeObject = object;
    const want = Math.min(1, dodgeBase * (config.enabled ? config.dodge : 1));
    // The engine stores this duration as float32; ignore its rounding residue.
    if (Math.abs(value - want) > 0.0000001) {
        flat.Value = want; magnitude.ScalableFloatMagnitude = flat; object.DurationMagnitude = magnitude;
        if (Math.abs(object.DurationMagnitude.ScalableFloatMagnitude.Value - want) > 0.00001) throw new Error("dodge readback mismatch");
        log("WINDOW dodge base=" + dodgeBase + " actual=" + object.DurationMagnitude.ScalableFloatMagnitude.Value);
    }
    dodgeLast = object.DurationMagnitude.ScalableFloatMagnitude.Value;
}
function readConfig() {
    const out = puerts.$ref("");
    if (!UE.EasyCsv.LoadStringFromLocalFile(configPath, out)) return;
    const text = puerts.$unref(out); if (text === configText) return;
    const next = Object.assign({}, defaults, JSON.parse(text));
    for (const n of ["enabled", "blue", "red", "selfTest"]) if (typeof next[n] !== "boolean") throw new Error("invalid boolean " + n);
    for (const [n, lo, hi] of [["deflect", 1, 3], ["dodge", 1, 3], ["speed", 0.25, 1], ["seconds", 0.2, 2]])
        if (!Number.isFinite(next[n]) || next[n] < lo || next[n] > hi) throw new Error("invalid range " + n);
    stop("config-change"); config = next; configText = text; log("CONFIG " + JSON.stringify(config));
}
let lastGameTime = -1, lastError = "";
function tick() {
    try {
        const real = Date.now();
        if (real >= configAt) { configAt = real + 1000; readConfig(); windows(); }
        const pawn = UE.GameplayStatics.GetPlayerCharacter(gi, 0);
        const path = pawn ? UE.KismetSystemLibrary.GetPathName(pawn) : "";
        if (path !== state.path || pawn !== state.pawn) bind(pawn, path);
        const now = clock(), reason = blocked(pawn);
        if (reason || now < lastGameTime) stop(reason || "world-clock-reset");
        else {
            if (state.active && (real >= state.active.deadline || now >= state.active.hit + 0.12)) stop("attack-ended-or-cap");
            if (state.pending && now >= state.pending.hit) state.pending = null;
            if (state.pending && now >= state.pending.hit - config.seconds * config.speed + 0.12) {
                const pending = state.pending; state.pending = null; start(pending.hit, pending.color, now);
            }
            // Explicit diagnostic mode: uses the real world subsystem, but synthetic attack timing.
            if (config.selfTest && state.sub && state.selfTest === 0 && real >= state.readyAt) {
                state.testStarts = state.starts; state.testStops = state.stops;
                state.selfTest = 1; log("SELFTEST synthetic blue timing through attack handler");
                onAttack({OptionalObject:{ReceiveFrame:{SourceAction:{DeflectType:2},HitGameTime:now+1.2,IsHit:false}}});
            } else if (config.selfTest && state.selfTest === 1 && !state.active) {
                if (!state.pending) {
                    if (state.starts !== state.testStarts + 1 || state.stops !== state.testStops + 1) {
                        state.selfTest = -1; log("SELFTEST_FAIL blue did not complete exactly once");
                    } else {
                        state.selfTest = 2; log("SELFTEST synthetic red timing through attack handler");
                        onAttack({OptionalObject:{ReceiveFrame:{SourceAction:{DeflectType:3},HitGameTime:now+1.2,IsHit:false}}});
                    }
                }
            } else if (config.selfTest && state.selfTest === 2 && !state.active) {
                if (!state.pending) {
                    state.selfTest = 3;
                    log(state.starts === state.testStarts + 2 && state.stops === state.testStops + 2
                        ? "SELFTEST_PASS blue+red each started/restored; synthetic timing, not enemy combat"
                        : "SELFTEST_FAIL red did not complete exactly once");
                }
            }
        }
        lastGameTime = now;
        if (real >= lastReport) {
            lastReport = real + 10000;
            log("STATUS " + JSON.stringify({pawn: state.path, events: state.events, blue: state.blue, red: state.red, starts: state.starts, stops: state.stops, active: !!state.active}));
        }
        lastError = "";
    } catch (e) {
        stop("error"); const text = String(e); if (text !== lastError) log("ERROR " + text); lastError = text;
    }
}
log("BOOTSTRAP_OK own source; no Mods Menu required");
setInterval(tick, 50);

const menuSpec = [
    ["enabled", "\uc804\ud22c \ubcf4\uc870", "\uc804\uccb4 \ucf1c\uae30 / \ub044\uae30"],
    ["deflect", "\uc644\ubcbd \ubc29\uc5b4", "\uae30\ubcf8 \ud310\uc815 \uc2dc\uac04\uc758 \ubc30\uc728", 1, 3, 0.25],
    ["dodge", "\uc644\ubcbd \ud68c\ud53c", "\uae30\ubcf8 \ud310\uc815 \uc2dc\uac04\uc758 \ubc30\uc728", 1, 3, 0.25],
    ["red", "\ube68\uac15 \uacf5\uaca9", "\uc2ac\ub85c\ubaa8\uc158", null],
    ["blue", "\ud30c\ub791 \uacf5\uaca9", "\uc2ac\ub85c\ubaa8\uc158", null],
    ["speed", "\uc2ac\ub85c\ubaa8\uc158 \uc18d\ub3c4", "\ub0ae\uc744\uc218\ub85d \ub290\ub9ac\uac8c", 0.25, 1, 0.05],
    ["seconds", "\ucd5c\ub300 \uc9c0\uc18d\uc2dc\uac04", "\ud55c \ubc88\uc758 \uc2ac\ub85c\ubaa8\uc158 / \uc2e4\uc81c \uc2dc\uac04", 0.2, 2, 0.1]
];
function menuValue(name) {
    const v = config[name];
    if (typeof v === "boolean") return v ? "\ucf1c\uc9d0" : "\uaebc\uc9d0";
    return name === "speed" ? Math.round(v * 100) + "%" : name === "seconds" ? v.toFixed(1) + "\ucd08" : v.toFixed(2) + "x";
}
function changeSetting(name, direction) {
    const spec = menuSpec.find(s => s[0] === name); if (!spec) return false;
    const next = Object.assign({}, config);
    next[name] = typeof next[name] === "boolean" ? !next[name] : Math.max(spec[3], Math.min(spec[4], Math.round((next[name] + direction * spec[5]) * 100) / 100));
    if (next[name] === config[name]) return true;
    const priorConfig = config, priorText = configText;
    const text = JSON.stringify(next, null, 2) + "\n", prior = JSON.stringify(config, null, 2) + "\n";
    try {
        // Preserve a last-good copy before replacing the small settings file.
        if (!UE.EasyCsv.SaveStringToFileWithFullPath(prior, configPath + ".previous")) throw new Error("backup write failed");
        if (!UE.EasyCsv.SaveStringToFileWithFullPath(text, configPath)) throw new Error("settings write failed");
        const out = puerts.$ref("");
        if (!UE.EasyCsv.LoadStringFromLocalFile(configPath, out) || puerts.$unref(out) !== text) throw new Error("settings readback failed");
        readConfig(); windows();
        refreshMenu("\uc800\uc7a5\ub428 \u00b7 \uc989\uc2dc \uc801\uc6a9"); log("MENU_SAVE " + name + "=" + config[name]); return true;
    } catch (e) {
        // Disk failure must not silently change the live configuration.
        config = priorConfig; configText = priorText;
        try { UE.EasyCsv.SaveStringToFileWithFullPath(prior, configPath); windows(); } catch (restoreError) { log("MENU_SAVE_ROLLBACK_ERROR " + restoreError); }
        refreshMenu("\uc800\uc7a5 \uc2e4\ud328 \u00b7 \uc124\uc815 \ud30c\uc77c\uc744 \ud655\uc778\ud558\uc138\uc694"); log("MENU_SAVE_ERROR " + e); return false;
    }
}
const menu = {panel:null,root:null,details:null,rows:[],active:false,blank:null,focus:0,enterSecond:false,lastStock:"Game",generation:0,down:true,request:null,error:"",message:"",refreshAt:0};
// The game owns the menu layer, pause, cursor, Back and its graphics dialogs.
// We add one settings tab, seven stock row views and our own persistence handlers.
const settingsTab = "JidonCombatAssist";
const textValue = value => UE.KismetTextLibrary.Conv_StringToText(value);
function tabText() { return new UE.FlowLocText(settingsTab, settingsTab, textValue("\uc804\ud22c \ubcf4\uc870")); }
function currentPanelOwnsInput() {
    if (!menu.panel || !UE.KismetSystemLibrary.IsValid(menu.panel) || !menu.panel.IsVisible()) return false;
    const router = require("Library/TsHelper").default.getlocalPlayerSubsystem(menu.panel,UE.PBZUIActionRouterBase.StaticClass());
    const owner = router && router.FindOwningActivatable(menu.panel,menu.panel.GetOwningLocalPlayer());
    return !!owner && router.GetActiveWidget() === owner;
}
function updateDetails(index, message) {
    const d = menu.details; if(!d) return;
    const spec = menuSpec[index] || menuSpec[0];
    d.SetVisibility(UE.ESlateVisibility.SelfHitTestInvisible);
    d.Text_SettingName.SetText(textValue(spec[1]));
    d.RichText_Description.SetText(textValue(spec[2] + "\n\n\ud604\uc7ac \uc124\uc815: " + menuValue(spec[0])
        + "\n\n\ud654\uc0b4\ud45c\ub97c \ub204\ub974\uba74 \uc989\uc2dc \uc801\uc6a9\ub418\uace0 \uc800\uc7a5\ub429\ub2c8\ub2e4."
        + "\nF9: \uc804\ud22c \ubcf4\uc870 \uc5f4\uae30 / Esc: \ub4a4\ub85c\uac00\uae30"
        + "\n\uc2ac\ub85c\ubaa8\uc158\uc740 \uc790\ub3d9 \ubc29\uc5b4\uac00 \uc544\ub2d9\ub2c8\ub2e4."
        + (message ? "\n\n"+message : "")));
    if(d.RichText_WarningDetails) d.RichText_WarningDetails.SetVisibility(UE.ESlateVisibility.Collapsed);
}
function refreshMenu(message) {
    if (!menu.active) return;
    for (const row of menu.rows) {
        const value = menuValue(row.name); if(row.shown === value) continue;
        const labels=UE.NewArray(UE.BuiltinText); labels.Add(textValue(value));
        row.view.Rotator_SettingValue.PopulateTextLabels(labels);
        row.view.Rotator_SettingValue.SetSelectedItem(0); row.shown=value;
    }
    updateDetails(menu.focus, message || menu.message);
    if(message) menu.message=message;
}
function selectMenuRow(index, focus) {
    if (!menu.active || !menu.rows[index]) return;
    menu.focus=index;
    menu.rows.forEach((r,i)=>{
        const selected=i===index;r.view.SetSelected(selected);
        r.view.Text_SettingName.OverrideTextColor(selected?r.view.SelectedColor:r.view.DefaultColor);
    });
    if(focus) menu.rows[index].button.SetKeyboardFocus();
    updateDetails(index,menu.message);
}
function dropMenuPage() {
    menu.active=false; menu.generation++;
    if(menu.root) try { menu.root.RemoveFromParent(); } catch(e) { log("MENU_REMOVE_ERROR "+e); }
    menu.root=null; menu.rows=[]; menu.details=null; menu.message="";
}
function leaveAssistTab() {
    if(menu.active && menu.panel) menu.panel.IsEnterSecond=menu.enterSecond;
    menu.active=false;
}
function positionLike(slot, source, container) {
    const geometry=container.GetCachedGeometry(), size=UE.SlateBlueprintLibrary.GetLocalSize(geometry);
    const g=source.GetCachedGeometry(), extent=UE.SlateBlueprintLibrary.GetLocalSize(g);
    if(size.X<=0 || extent.X<=0) throw new Error("settings layout not ready");
    const origin=UE.SlateBlueprintLibrary.AbsoluteToLocal(geometry,UE.SlateBlueprintLibrary.LocalToAbsolute(g,new UE.Vector2D(0,0)));
    const end=UE.SlateBlueprintLibrary.AbsoluteToLocal(geometry,UE.SlateBlueprintLibrary.LocalToAbsolute(g,extent));
    slot.SetHorizontalAlignment(UE.EHorizontalAlignment.HAlign_Fill);
    slot.SetVerticalAlignment(UE.EVerticalAlignment.VAlign_Fill);
    slot.SetPadding(new UE.Margin(origin.X,origin.Y,Math.max(0,size.X-end.X),Math.max(0,size.Y-end.Y)));
}
function menuNavigation(generation,index,delta,step) {
    return ()=>{
        if(generation!==menu.generation || !menu.active) return null;
        if(step) changeSetting(menu.rows[index].name,delta);
        const target=step?index:Math.max(0,Math.min(menu.rows.length-1,index+delta));
        selectMenuRow(target,false);return menu.rows[target].button;
    };
}
function menuRowClick(generation,index) {
    return ()=>{
        if(generation!==menu.generation || !menu.active) return;
        const row=menu.rows[index], mouse=UE.WidgetLayoutLibrary.GetMousePositionOnPlatform();
        const dec=row.view.Button_Decrease;
        const minus=UE.SlateBlueprintLibrary.IsUnderLocation(dec.GetCachedGeometry(),mouse);
        selectMenuRow(index,true); changeSetting(row.name,minus?-1:1);
    };
}
function createSettingsPage(panel) {
    const pc=UE.GameplayStatics.GetPlayerController(gi,0), sw=panel.WidgetSwitcher_65;
    const root=UE.NewObject(UE.Overlay.StaticClass(),panel), scroll=UE.NewObject(UE.ScrollBox.StaticClass(),panel);
    menu.root=root; sw.AddChild(root); positionLike(root.AddChild(scroll),panel.ListView_Settings,sw);
    scroll.SetScrollBarVisibility(UE.ESlateVisibility.Collapsed);
    const cls=UE.Class.Load("/Game/PBZContent/UI/Settings/Editors/W_SettingsListEntry_Discrete.W_SettingsListEntry_Discrete_C");
    const generation=++menu.generation;
    menu.rows=menuSpec.map((spec,index)=>{
        const view=UE.WidgetBlueprintLibrary.Create(gi,cls,pc), button=UE.NewObject(UE.Button.StaticClass(),panel);
        // Native row delegates expect a native GameSetting object. The stock row
        // is visual-only; a transparent wrapper owns our seven custom actions.
        const style=button.WidgetStyle;
        for(const name of ["Normal","Hovered","Pressed","Disabled"]) { const brush=style[name];brush.DrawAs=UE.ESlateBrushDrawType.NoDrawType;style[name]=brush; }
        style.NormalPadding=new UE.Margin(0,0,0,0);style.PressedPadding=new UE.Margin(0,0,0,0);button.SetStyle(style);
        const slot=button.AddChild(view);slot.SetPadding(new UE.Margin(0,0,0,0));
        slot.SetHorizontalAlignment(UE.EHorizontalAlignment.HAlign_Fill);slot.SetVerticalAlignment(UE.EVerticalAlignment.VAlign_Fill);
        view.SetVisibility(UE.ESlateVisibility.HitTestInvisible);
        view.Text_SettingName.SetText(textValue(spec[1]));
        view.SetSelected(false); scroll.AddChild(button);
        button.OnClicked.Add(menuRowClick(generation,index));
        button.OnHovered.Add(()=>{if(menu.generation===generation)selectMenuRow(index,true);});
        return {name:spec[0],view,button,shown:null};
    });
    for(let i=0;i<menu.rows.length;i++) {
        const button=menu.rows[i].button;
        for(const [dir,delta,step] of [[UE.EUINavigation.Left,-1,true],[UE.EUINavigation.Right,1,true],[UE.EUINavigation.Up,-1,false],[UE.EUINavigation.Down,1,false]])
            button.SetNavigationRuleCustom(dir,puerts.toDelegate(button,menuNavigation(generation,i,delta,step)));
    }
    const source=panel.Details_Settings, box=UE.NewObject(UE.SizeBox.StaticClass(),panel), originalBox=source.GetParent();
    for(const property of ["WidthOverride","HeightOverride","MinDesiredWidth","MinDesiredHeight","MaxDesiredWidth","MaxDesiredHeight"])
        if(originalBox["bOverride_"+property]) box["Set"+property](originalBox[property]);
    const slot=root.AddChild(box), oldSlot=originalBox.Slot;
    slot.SetPadding(oldSlot.Padding);slot.SetHorizontalAlignment(oldSlot.HorizontalAlignment);slot.SetVerticalAlignment(oldSlot.VerticalAlignment);
    menu.details=UE.WidgetBlueprintLibrary.Create(gi,source.GetClass(),pc);box.AddChild(menu.details);
    log("MENU_PAGE_BUILT stock_rows="+menu.rows.length);
}
function enterAssistTab(panel) {
    if(menu.panel!==panel) { dropMenuPage();menu.panel=panel; }
    if(!menu.root) createSettingsPage(panel);
    if(!menu.active) menu.enterSecond=panel.IsEnterSecond;
    if(!menu.blank || !UE.KismetSystemLibrary.IsValid(menu.blank)) menu.blank=new UE.GameSettingCollection();
    panel.CurrentCollection=menu.blank; // never null: native settings refresh dereferences it
    panel.RefreshKey(); menu.active=true; panel.IsEnterSecond=true;
    panel.WidgetSwitcher_65.SetActiveWidgetIndex(panel.WidgetSwitcher_65.GetChildIndex(menu.root));
    panel.W_SecondTabLine.InitDataByText(tabText());
    stop("settings-menu");refreshMenu(); selectMenuRow(0,true);
    log("MENU_OPEN native-settings "+JSON.stringify(config));
}
function registerAssistTab(panel) {
    const tabs=panel.W_OverlayTabList_C;
    for(let i=0;i<tabs.GetTabCount();i++) if(String(tabs.GetTabIdAtIndex(i))===settingsTab)return;
    const ref=puerts.$ref(new UE.PBZTabDescriptor());
    if(!tabs.GetPreregisteredTabInfo("View",ref))throw new Error("native settings tab template missing");
    const descriptor=puerts.$unref(ref);descriptor.TabId=settingsTab;descriptor.TabText=tabText();
    const icon=UE.Object.Load("/Game/PBZContent/UI/Settings/Texture/T_Setting_Icon.T_Setting_Icon");
    if(icon){const brush=descriptor.IconBrush;brush.ResourceObject=icon;descriptor.IconBrush=brush;}
    descriptor.TabContentType=null;descriptor.CreatedTabContentWidget=null;descriptor.bHidden=false;
    if(!tabs.RegisterDynamicTab(descriptor))throw new Error("native tab registration refused");
    const box=tabs.TabButtonBox, count=box.GetChildrenCount();
    if(count>2) { const before=box.GetChildAt(count-2).Slot,last=box.GetChildAt(count-1).Slot,first=box.GetChildAt(0).Slot;
        const m=before.Padding;last.SetPadding(new UE.Margin(m.Left,m.Top,m.Right,m.Bottom));before.SetPadding(first.Padding); }
    log("MENU_TAB_REGISTERED native-settings");
}
function openMenu() {
    if(currentPanelOwnsInput()) {registerAssistTab(menu.panel);menu.panel.W_OverlayTabList_C.SelectTabByID(settingsTab);return;}
    const pc=UE.GameplayStatics.GetPlayerController(gi,0),pawn=UE.GameplayStatics.GetPlayerCharacter(gi,0);
    if(!pc || !pawn || menu.request) return;
    const reason=blocked(pawn);if(reason && reason!=="disabled")return;
    if(!require("Library/UIHelper").default.canOpenSystemUI(pc))return;
    const path="/Game/PBZContent/UI/UINew/System/Setting/W_SettingActivateableWidget.W_SettingActivateableWidget_C";
    const cls=UE.KismetSystemLibrary.Conv_SoftClassPathToSoftClassRef(UE.KismetSystemLibrary.MakeSoftClassPath(path));
    const action=UE.AsyncAction_PushContentToLayerForPlayer.PushContentToLayerForPlayer(pc,cls,tag("UI.Layer.GameSystem"));
    menu.request={action,pc,at:Date.now(),host:null};
    action.BeforePush.Add(host=>{if(menu.request)menu.request.host=host;});
    action.Activate();log("MENU_OPEN_REQUEST native-layer");
}
function installSettingsHooks() {
    const prototype=require("UI/Setting/SettingPanel").SettingPanelMixinInterface.prototype;
    const required=["BP_InitWidget","OnTabSelected","FinishCurrentWidget","SelectWidgetToFocus","SelectDefaultGameSettingForDirectOpen","backInputInternal","ChangeInputMethod","ClickCollection","handleResetKeyPressed"];
    for(const name of required)if(typeof prototype[name]!=="function")throw new Error("settings interface missing "+name);
    const wrap=(name,handler)=>{const original=prototype[name];prototype[name]=function(...args){return handler.call(this,original,args);};};
    wrap("BP_InitWidget",function(original,args){
        if(menu.panel===this) {leaveAssistTab();dropMenuPage();}
        const result=original.apply(this,args);menu.panel=this;
        setTimeout(()=>{try {if(menu.panel===this && UE.KismetSystemLibrary.IsValid(this))registerAssistTab(this);}catch(e){log("MENU_TAB_ERROR "+e);}},100);
        return result;
    });
    wrap("OnTabSelected",function(original,args){
        if(String(args[0])!==settingsTab){if(menu.panel===this)leaveAssistTab();menu.lastStock=String(args[0]);return original.apply(this,args);}
        try {
            if(this.SettingWidget.HasVideoSettingChanged()) {
                this.W_OverlayTabList_C.SelectTabByID(menu.lastStock||"Game");
                if(this.CanNavigateToOtherWidgetOrCollection(settingsTab)===true && !this.SettingWidget.HasVideoSettingChanged())
                    setTimeout(()=>this.W_OverlayTabList_C.SelectTabByID(settingsTab),0);
                return;
            }
            enterAssistTab(this);
        }catch(e){log("MENU_ENTER_ERROR "+e);dropMenuPage();this.W_OverlayTabList_C.RemoveTab(settingsTab);this.W_OverlayTabList_C.SelectTabByID("Game");}
    });
    wrap("SelectDefaultGameSettingForDirectOpen",function(original,args){
        const host=menu.request && menu.request.host;
        if(!host || !host.W_SettingWidget || host.W_SettingWidget.Settings_Panel!==this)return original.apply(this,args);
        registerAssistTab(this);this.IsEnterSecond=true;
        setTimeout(()=>{try{if(menu.panel===this)this.W_OverlayTabList_C.SelectTabByID(settingsTab);}catch(e){log("MENU_DIRECT_ERROR "+e);}},150);
        menu.request=null;return true;
    });
    for(const name of ["SelectWidgetToFocus","ChangeInputMethod","ClickCollection"])
        wrap(name,function(original,args){if(menu.panel!==this || !menu.active)return original.apply(this,args);selectMenuRow(menu.focus,true);});
    wrap("handleResetKeyPressed",function(original,args){if(menu.panel!==this || !menu.active)return original.apply(this,args);});
    wrap("backInputInternal",function(original,args){return original.apply(this,menu.panel===this && menu.active?[true]:args);});
    wrap("FinishCurrentWidget",function(original,args){if(menu.panel===this){leaveAssistTab();dropMenuPage();menu.panel=null;log("MENU_CLOSED native-settings");}return original.apply(this,args);});
    const module=require("UI/Setting/SettingPanel"),release=module.releasePanelHostBinding;
    if(typeof release==="function")module.releasePanelHostBinding=function(panel,...args){
        if(menu.panel===panel){leaveAssistTab();dropMenuPage();menu.panel=null;log("MENU_CLOSED native-host");}
        return release.call(this,panel,...args);
    };
    log("MENU_HOOKS_READY native-settings");
}
function menuTick() {
    try {
        const pc=UE.GameplayStatics.GetPlayerController(gi,0);if(!pc)return;
        if(menu.request && (menu.request.pc!==pc || Date.now()-menu.request.at>8000)) {menu.request.action.Cancel();menu.request=null;log("MENU_REQUEST_CANCELLED");}
        const f9=new UE.Key("F9"),down=pc.IsInputKeyDown(f9)||pc.WasInputKeyJustPressed(f9);
        if(down && !menu.down)openMenu();
        menu.down=down;
        if(menu.active && !UE.KismetSystemLibrary.IsValid(menu.panel)){dropMenuPage();menu.panel=null;}
        if(menu.active && Date.now()>=menu.refreshAt){menu.refreshAt=Date.now()+250;refreshMenu();}
        menu.error="";
    }catch(e){const s=String(e);if(s!==menu.error)log("MENU_ERROR "+s);menu.error=s;}
}
try {installSettingsHooks();setInterval(menuTick,16);} catch(e) {log("MENU_DISABLED "+e);}
