import assert from "node:assert/strict";
import { ActivityCaptureEngine } from "../src/activity/captureEngine.js";
import { defaultActivitySettings } from "../src/activity/settings.js";

let nativeCalls = 0;
let desktopCalls = 0;
const engine = new ActivityCaptureEngine({
  native: async () => { nativeCalls++; throw new Error("native unavailable"); },
  desktop: async () => { desktopCalls++; return Buffer.from("desktop"); },
  frame: async (bytes) => ({ jpeg: bytes, width: 2, height: 2, pixels: Buffer.from([0,0,0,255,255,255,255,255]) })
});
const first = await engine.capture({ ...defaultActivitySettings, captureDebounceMs: 0 }, "heartbeat");
assert.ok(first);
const second = await engine.capture({ ...defaultActivitySettings, captureDebounceMs: 0 }, "heartbeat");
assert.ok(second, "heartbeat 不被去重");
assert.equal(nativeCalls, 1, "原生失败的粘性状态由主进程持有");
assert.equal(desktopCalls, 2);
assert.equal(await engine.capture({ ...defaultActivitySettings, captureDebounceMs: 0 }, "click"), undefined, "相同画面不重复保存");
engine.resetBaseline();
assert.ok(await engine.capture({ ...defaultActivitySettings, captureDebounceMs: 0 }, "app_focus"));
assert.equal(nativeCalls, 1, "应用切换只重置基线，不恢复原生尝试");

// 两帧颜色分布相同，但窗口内容换位；直方图接近时必须继续比较像素。
let pixels = Buffer.from([0,0,0,255,255,255,255,255]);
const changes = new ActivityCaptureEngine({
  native: async () => Buffer.from("frame"), desktop: async () => Buffer.from("frame"),
  frame: async jpeg => ({jpeg, width:2, height:1, pixels})
});
assert.ok(await changes.capture({ ...defaultActivitySettings, captureDebounceMs: 0 }, "app_focus"));
pixels = Buffer.from([255,255,255,255,0,0,0,255]);
assert.ok(await changes.capture({ ...defaultActivitySettings, captureDebounceMs: 0 }, "click"), "颜色分布相同不能吞掉位置变化");

// 新一轮录制重试原生；视觉探测只先取缩略图，有变化才取完整图。
engine.restart();
await engine.capture({ ...defaultActivitySettings, captureDebounceMs: 0 }, "heartbeat");
assert.equal(nativeCalls, 2);
let clock = 10000;
const widths: number[] = [];
let imageValue = 0;
const probing = new ActivityCaptureEngine({
  now: () => clock,
  native: async width => { widths.push(width); return Buffer.from([imageValue]); },
  desktop: async () => { throw new Error('not used'); },
  frame: async jpeg => ({jpeg, width:2,height:1,pixels:Buffer.from([jpeg[0]!,0,0,255])})
});
await probing.capture(defaultActivitySettings, 'visual_change');
assert.deepEqual(widths, [160,2560]);
clock += 12000;
await probing.capture(defaultActivitySettings, 'visual_change');
assert.deepEqual(widths, [160,2560,160]);
imageValue = 255;
clock += 100;
await probing.capture(defaultActivitySettings, 'heartbeat');
assert.equal(widths.length, 3, '所有触发共享 debounce');
let attempts = 0;
const failing = new ActivityCaptureEngine({now:()=>clock,
 native:async()=>{throw new Error('native');}, desktop:async()=>{attempts++;throw new Error('desktop');},
 frame:async()=>{throw new Error('never');}});
const fast = {...defaultActivitySettings,captureDebounceMs:0};
await assert.rejects(failing.capture(fast,'click'));
clock += 100;
await failing.capture(fast,'heartbeat');
assert.equal(attempts,1,'失败后 500ms 内退避');
clock += 500;
await assert.rejects(failing.capture(fast,'click'));
assert.equal(attempts,2);

// 低清探测成功但完整截图失败，不能把未保存的画面当成去重基线。
let fullAttempt = 0;
const retryFull = new ActivityCaptureEngine({now:()=>clock,
 native:async width=>{if(width===2560)throw new Error('native full failed');return Buffer.from('preview');},
 desktop:async width=>{if(width===2560 && ++fullAttempt===1)throw new Error('full failed');return Buffer.from('frame');},
 frame:async jpeg=>({jpeg,width:1,height:1,pixels:Buffer.from([0,0,0,255])})
});
await assert.rejects(retryFull.capture(fast,'visual_change'));
clock+=1000;
assert.ok(await retryFull.capture(fast,'visual_change'),'重试应完成此前未保存的完整截图');
