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
    const want = Math.min(cap, rec.base * multiplier);
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
    if (value !== want) {
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
