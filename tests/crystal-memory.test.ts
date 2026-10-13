import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CrystalService, normalizeTerms, normalizeTerm } from "../src/agent/context/crystalService.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-memory-"));
const storage = new CrystalStorage({ agentDir: root });
const service = new CrystalService({
  storage,
  getConfig: () => ({
    passiveEnabled: true,
    semanticScanEnabled: false,
    contour: { count: 2, turns: 2, spread: 1 },
    nucleus: { count: 3, turns: 3, spread: 1 },
    dormantDays: 14
  }),
  extractTerms: async () => []
});

try {
await testPrefillMaterialWindow();
await testSemanticCandidateFailureIsolation();
await testAnchorRetryAfterExtractionFailure();
  await service.initialize();
  assert.deepEqual(service.overview().types, ["entity", "concept", "claim", "process", "rule", "project"]);
  const bundle = storage.insertBundle({ id: "bundle-verbatim", name: "  原始名称  ", threadId: "bundle-thread", anchorIds: ["anchor-b", "anchor-a", "anchor-b"], createdAt: "2026-08-01T00:00:00.000Z" });
  assert.equal(bundle.name, "  原始名称  ");
  assert.deepEqual(bundle.anchorIds, ["anchor-b", "anchor-a", "anchor-b"]);
  assert.deepEqual(storage.getBundle(bundle.id), bundle);
  const unnamedBundle = storage.insertBundle({ id: "bundle-empty-name", name: "", threadId: "bundle-thread", anchorIds: [] });
  assert.equal(storage.getBundle(unnamedBundle.id)?.name, "");
  const listedBundles = Array.from({ length: 205 }, (_, index) => storage.insertBundle({
    id: `listed-${String(205 - index).padStart(3, "0")}`,
    threadId: "listed-thread",
    anchorIds: [],
    createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString()
  }));
  assert.deepEqual(storage.listBundles("listed-thread"), [...listedBundles].reverse());
  assert.deepEqual(storage.listBundles(), [...listedBundles].reverse().slice(0, 200));
  assert.deepEqual(storage.listBundles(""), storage.listBundles());
  assert.deepEqual(storage.listBundles("missing-thread"), []);
  const orderedMaterials = [
    { id: 9003, createdAt: "2026-08-03T00:00:00.000Z" },
    { id: 9002, createdAt: "2026-08-01T00:00:00.000Z" },
    { id: 9001, createdAt: "2026-08-02T00:00:00.000Z" }
  ];
  for (const material of orderedMaterials) {
    storage.importMaterial({ ...material, crystalId: "material-order", kind: "note", source: "user", ref: { text: String(material.id) } });
  }
  assert.deepEqual(storage.listMaterials("material-order").map((material) => material.id), [9002, 9001, 9003]);
  const beforeEmptyTerms = storage.listTerms();
  const empty = await service.processAnchor({ threadId: "empty", anchorId: "empty-anchor", day: "2026-09-06", text: " \n\t ", terms: ["MustNotCount"] });
  assert.deepEqual(empty, { claimed: true, terms: [], contoured: 0, nucleated: [], woken: [], materialsAdded: 0 });
  assert.equal(storage.hasProcessedAnchor("empty-anchor"), true);
  assert.deepEqual(storage.listTerms(), beforeEmptyTerms);
  assert.equal((await service.processAnchor({ threadId: "empty", anchorId: "empty-anchor", day: "2026-09-06", text: "Changed later", terms: ["MustNotCount"] })).claimed, false);
  const explicitTerms = Array.from({ length: 17 }, (_, index) => `Explicit${index}`);
  assert.equal(normalizeTerms(explicitTerms).length, 17);
  assert.equal(normalizeTerm('["ProjectX"]'), "projectx");
  assert.equal(normalizeTerm('" ProjectX "'), " projectx ");
  assert.equal(normalizeTerm("ProjectX("), "projectx");
  let extractionOutput = "";
  let extractionCalls = 0;
  const extractionModel: AgentModel = {
    provider: "test",
    modelId: "crystal-extraction",
    stream: async (request, options) => {
      extractionCalls += 1;
      assert.equal(createHash("sha256").update(request.systemPrompt ?? "").digest("hex"), "d8f0100261e8ba5acdbe5ef9fadb8ba6a476e8853be90b6635f0a69b7eb89978");
      assert.deepEqual(request.messages, [{ role: "user", content: [{ type: "text", text: "ProjectX review" }] }]);
      assert.equal(options?.maxOutputTokens, undefined);
      assert.equal(options?.reasoning, undefined);
      assert.equal(options?.timeoutMs, 30_000);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: extractionOutput };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  const extractionService = new CrystalService({ storage, getModel: () => extractionModel });
  assert.deepEqual(await extractionService.extract("   x   "), []);
  assert.equal(extractionCalls, 0);
  for (const [output, expected] of [
    ['["ProjectX", 17, null, "ProjectX", "代码", "结晶"]', ["ProjectX", "ProjectX", "代码", "结晶"]],
    ['  ```json\n["ProjectX"]\n```  ', ["ProjectX"]],
    ['```\n["ProjectX"]\n```', ["ProjectX"]],
    ['```JSON\n["ProjectX"]\n```', []],
    ['Result: ["ProjectX"]', []],
    ['["ProjectX",', []],
    ['{"term":"ProjectX"}', []],
    [JSON.stringify(Array.from({ length: 17 }, (_, index) => `Topic${index}`)), Array.from({ length: 16 }, (_, index) => `Topic${index}`)]
  ] as const) {
    extractionOutput = output;
    assert.deepEqual(await extractionService.extract("ProjectX review"), expected);
  }
  const first = await service.processAnchor({
    threadId: "thread-1",
    anchorId: "message-1",
    day: "2026-09-05",
    text: "ProjectX",
    terms: ["ProjectX"]
  });
  assert.equal(first.claimed, true);
  assert.equal((await service.processAnchor({
    threadId: "thread-1",
    anchorId: "message-1",
    day: "2026-09-05",
    text: "ProjectX",
    terms: ["ProjectX"]
  })).claimed, false);
  await service.processAnchor({ threadId: "thread-2", anchorId: "message-2", day: "2026-09-06", text: "ProjectX", terms: ["ProjectX"] });
  const third = await service.processAnchor({ threadId: "thread-3", anchorId: "message-3", day: "2026-09-07", text: "ProjectX", terms: ["ProjectX"] });
  assert.equal(third.nucleated.length, 1);
  const term = storage.listTerms()[0];
  assert.equal(term?.status, "nucleus");
  const crystal = third.nucleated[0];
  assert.ok(crystal);
  assert.deepEqual(service.detail(crystal.id)?.termStats, { count: 3, turns: 3, threads: 3, days: 3 });
  assert.equal(service.detail(crystal.id)?.checklistSpec, null);
  assert.equal(storage.listMaterials(crystal.id).length, 3);
  assert.deepEqual(storage.listMaterials(crystal.id)[0]?.ref, { threadId: "thread-1", anchorId: "message-1" });
  const activeOccurrence = await service.processAnchor({ threadId: "thread-3", anchorId: "message-active", day: "2026-09-07", text: "ProjectX", terms: ["ProjectX"] });
  assert.equal(activeOccurrence.woken.length, 0);
  assert.deepEqual(service.detail(crystal.id)?.termStats, { count: 4, turns: 4, threads: 3, days: 3 });
  service.setDormant(crystal.id, true);
  const wakeOccurrence = await service.processAnchor({ threadId: "thread-3", anchorId: "message-wake", day: "2026-09-07", text: "ProjectX", terms: ["ProjectX"] });
  assert.equal(wakeOccurrence.woken.length, 1);
  assert.equal(storage.getCrystal(crystal.id)?.dormant, false);
  assert.equal(service.cancel(crystal.id, true).dormant, true);
  assert.equal(service.setSlot(crystal.id, null).dormant, true);
  service.setDormant(crystal.id, false);

  const agingNow = new Date("2026-10-01T00:00:00.000Z");
  const aging = new CrystalService({ storage, now: () => agingNow });
  const old = { ...storage.getCrystal(crystal.id)!, updatedAt: "2026-01-01T00:00:00.000Z" };
  storage.putCrystal(old);
  await aging.processAnchor({ threadId: "aging", anchorId: "aging-unrelated", day: "2026-10-01", text: "Unrelated topic", terms: [] });
  assert.equal(storage.getCrystal(crystal.id)?.dormant, false);
  aging.dormantOldCrystals();
  assert.equal(storage.getCrystal(crystal.id)?.dormant, true);
  assert.equal(storage.getCrystal(crystal.id)?.updatedAt, old.updatedAt);
  aging.dormantOldCrystals();
  assert.equal(storage.getCrystal(crystal.id)?.updatedAt, old.updatedAt);
  service.setDormant(crystal.id, false);

  service.setType(crystal.id, "concept");
  for (const field of ["definition", "includes", "excludes", "examples", "source"]) {
    service.updateChecklist(crystal.id, field, { value: `${field} value`, sources: [`message-${field}`] });
  }
  const formal = service.confirm(crystal.id);
  assert.equal(formal.stage, "formal");
  assert.equal(await service.promptText("ProjectX"), undefined);
  assert.equal(await service.promptText("Unrelated task"), undefined);
  assert.match((await service.promptText(`@[ProjectX](biny://crystal/${crystal.id})`)) ?? "", /projectx/u);
  assert.match((await service.promptText("@[missing](biny://crystal/missing)")) ?? "", /MISSING/u);

  const seed = service.createSeed("Release Theme");
  assert.equal(service.detail(seed.id)?.termStats, null);
  assert.equal(service.detail(seed.id)?.checklistSpec, null);
  assert.equal(service.detail("missing-crystal"), undefined);
  assert.equal(service.cancel(seed.id, true).dormant, false);
  assert.equal(service.cancel(seed.id, false).dormant, true);
  service.setSlot(seed.id, 1);
  service.setDormant(seed.id, false);
  assert.equal(service.search("Release Theme")[0]?.score, 100);
  assert.equal(service.search("Release")[0]?.score, 80);
  assert.equal(service.search("RlsThm")[0]?.score, 20);
  assert.deepEqual(service.search("Nonexistent unrelated object"), []);
  service.setType(seed.id, "concept");
  assert.deepEqual(service.detail(seed.id)?.checklistSpec, ["definition", "includes", "excludes", "examples", "source"]);
  await assert.rejects(service.prefill(seed.id), /No materials/u);
  assert.match((await service.promptText(`@[seed](biny://crystal/${seed.id})`)) ?? "", /seed \(user-planted candidate\)/u);
  const repeatedReferences = (await service.promptText(`@[first label](biny://crystal/${seed.id}) @[second label](biny://crystal/${seed.id})`))!;
  assert.ok(repeatedReferences.includes(`- @first label → biny://crystal/${seed.id} [crystal]\n  title: Release Theme`));
  assert.equal(repeatedReferences.includes("second label"), false);
  const manyReferences = (await service.promptText(Array.from({ length: 25 }, (_, index) => `@[label${index}](biny://crystal/missing${index})`).join(" ")))!;
  assert.equal((manyReferences.match(/\(MISSING\)/gu) ?? []).length, 24);
  assert.equal(manyReferences.includes("missing24"), false);
  const historicalCard = (await service.promptText("No current references", 8_000, [
    `@[old label](biny://crystal/${seed.id})`,
    `@[latest label](biny://crystal/${seed.id})`
  ]))!;
  assert.ok(historicalCard.includes("Referenced earlier in this thread"));
  assert.ok(historicalCard.includes("@latest label"));
  assert.equal(historicalCard.includes("@old label"), false);
  assert.equal(historicalCard.includes("Checklist not filled yet."), false);
  const currentWins = (await service.promptText(`@[current](biny://crystal/${seed.id})`, 8_000, [`@[old](biny://crystal/${seed.id})`]))!;
  assert.equal(currentWins.includes("Referenced earlier"), false);
  const cappedHistory = (await service.promptText("No current references", 8_000, Array.from({ length: 17 }, (_, index) => `@[past${index}](biny://crystal/past${index})`)))!;
  assert.equal((cappedHistory.match(/\(MISSING\)/gu) ?? []).length, 16);
  assert.ok(cappedHistory.indexOf("@past16") < cappedHistory.indexOf("@past1 "));
  assert.equal(cappedHistory.includes("@past0 "), false);
  const seeded = await service.processAnchor({
    threadId: "thread-4",
    anchorId: "message-4",
    day: "2026-09-08",
    text: "Release Theme needs review",
    terms: []
  });
  assert.equal(seeded.materialsAdded, 1);
  assert.equal(storage.listMaterials(seed.id).length, 1);
  service.addMaterial(crystal.id, "turn", { threadId: "thread-4", anchorId: "message-4" });
  assert.equal(service.detail(seed.id)?.related[0]?.id, crystal.id);
  assert.equal(service.detail(seed.id)?.related[0]?.shared, 1);
  await assert.rejects(service.prefill(seed.id), /no readable text/u);
  const importedMaterial = { id: 100_001, crystalId: seed.id, kind: "note" as const, ref: { text: "Imported evidence." }, source: "user" as const, createdAt: "2026-08-01T00:00:00.000Z" };
  assert.equal(storage.importMaterial(importedMaterial), true);
  assert.equal(storage.importMaterial(importedMaterial), false);
  assert.equal(storage.listMaterials(seed.id).find((material) => material.id === 100_001)?.createdAt, importedMaterial.createdAt);
  assert.throws(() => storage.importMaterial({ ...importedMaterial, ref: { text: "Different evidence" } }), /id conflicts/u);
  assert.throws(() => storage.importMaterial({ ...importedMaterial, source: "auto" }), /id conflicts/u);
  assert.throws(() => storage.importMaterial({ ...importedMaterial, createdAt: "2026-08-02T00:00:00.000Z" }), /id conflicts/u);
  assert.deepEqual(storage.listMaterials(seed.id).find((material) => material.id === importedMaterial.id), importedMaterial);

  service.addMaterial(seed.id, "note", { text: "Release Theme is the concise definition for the release focus." });
  service.setType(seed.id, "concept");
  const noteId = storage.listMaterials(seed.id).find((material) => material.kind === "note")?.id;
  const noteTag = `note:${String(noteId)}`;
  await assert.rejects(service.prefill(seed.id), /model is unavailable/u);
  assert.deepEqual(storage.getCrystal(seed.id)?.checklist, {});
  const paddedNote = `  ${"n".repeat(410)}  `;
  service.addMaterial(seed.id, "note", { text: paddedNote });
  service.addMaterial(seed.id, "note", { text: "   " });
  const prefillModel: AgentModel = {
    provider: "test",
    modelId: "crystal-prefill",
    stream: async (request, options) => (async function* (): AsyncGenerator<ModelStreamEvent> {
      assert.equal(request.systemPrompt, `你是一个资料整理员。根据来源材料，为对象「Release Theme」预填清单字段。\n每个字段输出 {"value": "...", "sources": ["tag", ...]}，sources 必须引用给出的材料 tag，且只引用真正支持该 value 的材料。\n材料不足以填写的字段输出 null，绝不编造。\n只输出一个 JSON 对象，键为字段名。不要任何解释。`);
      assert.equal(options?.maxOutputTokens, undefined);
      assert.equal(options?.reasoning, undefined);
      assert.equal(options?.timeoutMs, 30_000);
      const expectedMaterials = storage.listMaterials(seed.id).flatMap((material) => {
        if (material.kind === "note") return [`[note:${material.id}] ${(material.ref as { text: string }).text.slice(0, 400)}`];
        if (material.kind === "turn") return [`[turn:message-4]   Referenced conversation text  `];
        return [];
      });
      assert.deepEqual(request.messages, [{ role: "user", content: [{ type: "text", text: ["字段: definition, includes, excludes, examples, source", "", "材料:", ...expectedMaterials].join("\n") }] }]);
      service.updateChecklist(seed.id, "definition", { value: "User edited during prefill", sources: [noteTag] });
      yield { type: "text-delta", text: JSON.stringify({
        definition: { value: "Release focus", sources: [noteTag] },
        includes: { value: "Release planning", sources: [noteTag, "missing-source", noteTag, null, 17] },
        excludes: { value: "Unrelated work", sources: [noteTag] },
        examples: { value: "Release Theme", sources: [noteTag] },
        source: { value: "Project note", sources: [noteTag] }
      }) };
      yield { type: "finish", reason: "stop" };
    })()
  };
  let readyEvents = 0;
  const prefillService = new CrystalService({
    storage,
    getModel: () => prefillModel,
    readAnchorText: async (anchor) => {
      assert.deepEqual(anchor, { threadId: "thread-4", anchorId: "message-4" });
      return "  Referenced conversation text  ";
    },
    onEvent: (event) => { if (event.type === "crystal_ready") readyEvents += 1; }
  });
  await prefillService.initialize();
  const prefilled = await prefillService.prefill(seed.id);
  assert.equal(prefilled.checklist.definition?.value, "User edited during prefill");
  assert.deepEqual(prefilled.checklist.includes?.sources, [noteTag, noteTag]);
  assert.deepEqual(storage.getCrystal(seed.id)?.checklist.includes?.sources, [noteTag, noteTag]);
  assert.equal(prefilled.notified, true);
  prefillService.updateChecklist(seed.id, "definition", { value: "Reviewed release focus" });
  await prefillService.prefill(seed.id);
  assert.equal(readyEvents, 1);
  assert.equal(storage.getCrystal(seed.id)?.checklist.definition?.value, "Reviewed release focus");
  prefillService.updateChecklist(seed.id, "includes", { value: `first\n  second\t${"detail ".repeat(180)}` });
  const longCard = (await prefillService.promptText(`@[Release Theme](biny://crystal/${seed.id})`))!;
  const summaryLine = longCard.split("\n").find((line) => line.startsWith("  结晶"))!;
  assert.ok(summaryLine.includes("first second detail"));
  assert.ok(summaryLine.length <= 602);
  assert.ok(summaryLine.endsWith("…"));
  assert.equal(longCard.includes("title: Release Theme"), false);
  prefillService.close();

  storage.close();
  const reopened = new CrystalStorage({ agentDir: root });
  await reopened.initialize();
  assert.deepEqual(reopened.getBundle(bundle.id), bundle);
  assert.deepEqual(reopened.getBundle(unnamedBundle.id), unnamedBundle);
  assert.deepEqual(reopened.listMaterials("material-order").map((material) => material.id), [9002, 9001, 9003]);
  assert.equal(reopened.listCrystals().length, 2);
  assert.equal(reopened.listTerms()[0]?.count, 5);
  const recordingService = new CrystalService({ storage: reopened, getModel: () => extractionModel });
  recordingService.recordTerms(explicitTerms, { threadId: "explicit-thread", anchorId: "explicit-anchor", day: "2026-09-09", source: "conversation" });
  assert.equal(reopened.listTerms().filter((entry) => entry.term.startsWith("explicit")).length, 17);
  recordingService.recordTerms(explicitTerms, { threadId: "explicit-thread", anchorId: "explicit-anchor", day: "2026-09-09", source: "conversation" });
  assert.ok(reopened.listTerms().filter((entry) => entry.term.startsWith("explicit")).every((entry) => entry.count === 1));
  extractionOutput = JSON.stringify(['" QuotedTopic "']);
  const quoted = await recordingService.processAnchor({ threadId: "quote-thread", anchorId: "quote-anchor", day: "2026-09-09", text: "ProjectX review" });
  assert.deepEqual(quoted.terms, [" quotedtopic "]);
  assert.equal(reopened.listTerms().find((entry) => entry.term === " quotedtopic ")?.count, 1);
  reopened.close();
} finally {
  service.close();
  await rm(root, { recursive: true, force: true });
}

console.log("crystal memory tests passed");

async function testPrefillMaterialWindow(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-prefill-window-"));
  const store = new CrystalStorage({ agentDir: directory });
  let calls = 0;
  const model: AgentModel = {
    provider: "test",
    modelId: "material-window",
    stream: async (request) => {
      calls += 1;
      const expected = Array.from({ length: 29 }, (_, index) => `[note:${31 - (index + 1)}] evidence-${index + 1}`);
      assert.deepEqual(request.messages, [{ role: "user", content: [{ type: "text", text: ["字段: definition, includes, excludes, examples, source", "", "材料:", ...expected].join("\n") }] }]);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: "{}" };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  const service = new CrystalService({ storage: store, getModel: () => model });
  try {
    await service.initialize();
    const seed = service.createSeed("Window");
    service.setType(seed.id, "concept");
    const beforeConfirmation = store.getCrystal(seed.id)!;
    const longName = "完整名称".repeat(80);
    const partialChecklist = { definition: { value: "Partial definition", sources: ["note:2"], conflict: undefined } };
    assert.throws(() => service.confirm(seed.id, { name: `  ${longName}  `, checklist: partialChecklist }), /not ready|incomplete/iu);
    const unconfirmed = store.getCrystal(seed.id)!;
    assert.equal(unconfirmed.name, longName);
    assert.deepEqual(unconfirmed.checklist, partialChecklist);
    assert.equal(unconfirmed.stage, "candidate");
    assert.equal(unconfirmed.slot, beforeConfirmation.slot);
    assert.equal(unconfirmed.updatedAt, beforeConfirmation.updatedAt);
    assert.equal(unconfirmed.formalAt, undefined);
    const edited = service.updateChecklist(seed.id, "definition", { value: "  原始清单值  ", sources: ["note:2", "note:2", "note:1"] });
    assert.deepEqual(edited.checklist.definition, { value: "  原始清单值  ", sources: ["note:2", "note:2", "note:1"], conflict: undefined });
    assert.equal(store.getCrystal(seed.id)?.checklist.definition?.value, "  原始清单值  ");
    assert.deepEqual(store.getCrystal(seed.id)?.checklist.definition?.sources, ["note:2", "note:2", "note:1"]);
    service.updateChecklist(seed.id, "definition", { value: "", sources: [] });
    for (let index = 30; index >= 0; index -= 1) {
      store.importMaterial({ id: 31 - index, crystalId: seed.id, kind: "note", source: "user", ref: index === 0 ? null : { text: `evidence-${index}` }, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() });
    }
    await service.prefill(seed.id);
    assert.equal(calls, 1);
    assert.equal(store.listMaterials(seed.id).length, 31);
    for (const field of ["source", "examples", "excludes", "includes", "definition"]) {
      service.updateChecklist(seed.id, field, { value: `Reviewed ${field}`, sources: ["note:2"] });
    }
    const typed = service.setType(seed.id, "concept");
    assert.deepEqual(Object.keys(typed.checklist), ["definition", "includes", "excludes", "examples", "source"]);
    assert.deepEqual(Object.keys(store.getCrystal(seed.id)!.checklist), Object.keys(typed.checklist));
    assert.equal(typed.notified, false);
    const formal = service.confirm(seed.id);
    assert.equal(formal.stage, "formal");
    assert.equal(formal.name, longName);
    assert.equal(formal.slot, undefined);
    assert.equal(formal.dormant, false);
    assert.ok(formal.formalAt);
    const persistedFormal = store.getCrystal(seed.id)!;
    assert.deepEqual(service.confirm(seed.id, { name: "Must not rename", checklist: {} }), persistedFormal);
    assert.deepEqual(store.getCrystal(seed.id), persistedFormal);
    store.close();
    await store.initialize();
    assert.deepEqual(store.getCrystal(seed.id), persistedFormal);
    assert.deepEqual(service.confirm(seed.id), persistedFormal);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function testSemanticCandidateFailureIsolation(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-failure-"));
  const store = new CrystalStorage({ agentDir: directory });
  const scanner = new CrystalService({
    storage: store,
    getConfig: () => ({ passiveEnabled: false, semanticScanEnabled: true }),
    embedText: async () => new Float32Array([1, 0])
  });
  try {
    await scanner.initialize();
    const firstName = `FirstCandidate${"长名称".repeat(80)}`;
    const first = scanner.createSeed(`  ${firstName}  `);
    assert.equal(first.name, firstName);
    assert.equal(store.getCrystal(first.id)?.name, firstName);
    const second = scanner.createSeed("SecondCandidate");
    const original = store.addMaterial;
    const attempted: string[] = [];
    store.addMaterial = function (...args) {
      attempted.push(args[0]);
      if (args[0] === first.id) throw new Error("injected material write failure");
      return original.apply(this, args);
    };
    const result = await scanner.processAnchor({ threadId: "failure-thread", anchorId: "failure-anchor", text: "Unrelated input text" });
    assert.deepEqual(attempted, [first.id, second.id]);
    assert.equal(result.materialsAdded, 1);
    assert.equal(store.listMaterials(first.id).length, 0);
    assert.equal(store.listMaterials(second.id)[0]?.source, "auto-semantic");
    assert.equal(store.hasProcessedAnchor("failure-anchor"), true);

    store.addMaterial = original;
    const putCrystal = store.putCrystal;
    const beforeFirst = store.getCrystal(first.id);
    const updated: string[] = [];
    store.putCrystal = function (crystal) {
      updated.push(crystal.id);
      if (crystal.id === first.id) throw new Error("injected crystal update failure");
      return putCrystal.call(this, crystal);
    };
    const partial = await scanner.processAnchor({ threadId: "failure-thread", anchorId: "partial-anchor", text: "Unrelated partial update" });
    assert.deepEqual(updated, [first.id, second.id]);
    assert.equal(partial.materialsAdded, 1);
    assert.equal(store.listMaterials(first.id).length, 0); // Material and metadata roll back together.
    assert.equal(store.listMaterials(second.id).length, 2);
    assert.deepEqual(store.getCrystal(first.id), beforeFirst);
    assert.equal(store.hasProcessedAnchor("partial-anchor"), true);
    store.putCrystal = putCrystal;
    const repeated = await scanner.processAnchor({ threadId: "failure-thread", anchorId: "partial-anchor", text: "Unrelated partial update" });
    assert.equal(repeated.claimed, false);
    assert.equal(store.listMaterials(first.id).length, 0); // Material and metadata roll back together.
    assert.equal(store.listMaterials(second.id).length, 2);

    const controller = new AbortController();
    attempted.length = 0;
    store.addMaterial = function (...args) {
      attempted.push(args[0]);
      controller.abort(new Error("injected cancellation"));
      throw controller.signal.reason;
    };
    await assert.rejects(scanner.processAnchor({ threadId: "failure-thread", anchorId: "cancel-anchor", text: "Another unrelated input", signal: controller.signal }), /injected cancellation/);
    assert.deepEqual(attempted, [first.id]);

    attempted.length = 0;
    store.addMaterial = function (...args) {
      attempted.push(args[0]);
      throw new Error("injected direct match failure");
    };
    await assert.rejects(scanner.processAnchor({ threadId: "failure-thread", anchorId: "direct-failure-anchor", text: `${firstName} and SecondCandidate` }), /injected direct match failure/);
    assert.deepEqual(attempted, [first.id]);
    assert.equal(store.hasProcessedAnchor("direct-failure-anchor"), false);
    store.addMaterial = original;
    const retried = await scanner.processAnchor({ threadId: "failure-thread", anchorId: "direct-failure-anchor", text: `${firstName} and SecondCandidate` });
    assert.equal(retried.claimed, true);
    const unlinked = scanner.createSeed("Unlinked", { anchorIds: ["source-anchor"] });
    assert.deepEqual(store.listMaterials(unlinked.id)[0]?.ref, { threadId: null, anchorId: "source-anchor" });
  } finally {
    scanner.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function testAnchorRetryAfterExtractionFailure(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-retry-"));
  const store = new CrystalStorage({ agentDir: directory });
  let attempts = 0;
  const retryable = new CrystalService({
    storage: store,
    getConfig: () => ({ passiveEnabled: true, semanticScanEnabled: false }),
    extractTerms: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("model unavailable");
      return ["RetryProject"];
    }
  });
  try {
    await retryable.initialize();
    await assert.rejects(retryable.processAnchor({
      threadId: "retry-thread",
      anchorId: "retry-anchor",
      day: "2026-09-07",
      text: "RetryProject review"
    }), /model unavailable/);
    assert.equal(store.hasProcessedAnchor("retry-anchor"), false);
    const result = await retryable.processAnchor({
      threadId: "retry-thread",
      anchorId: "retry-anchor",
      day: "2026-09-07",
      text: "RetryProject review"
    });
    assert.equal(result.claimed, true);
    assert.equal(store.hasProcessedAnchor("retry-anchor"), true);
    assert.equal(store.listTerms().find((term) => term.term === "retryproject")?.count, 1);
  } finally {
    retryable.close();
    await rm(directory, { recursive: true, force: true });
  }
}
