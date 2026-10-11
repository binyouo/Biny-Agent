/** 用真实 CLI、配置与本地 SQLite 验证无模型时的骨架日报链路。 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { ActivityStore } from "../src/activity/store.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-cli-runtime-"));
try {
  await mkdir(path.join(root, "agent"));
  await writeFile(path.join(root, "agent", "config.json"), JSON.stringify({
    ...defaultConfig,
    activity: { ...defaultConfig.activity, outputDirectory: path.join(root, "snapshots") }
  }));
  const result = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    path.resolve("src/cli/index.ts"),
    "activity", "report", "today", "--skeleton", "--json"
  ], {
    cwd: root,
    env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent") },
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { date: string; markdown: string; sessionCount: number; narrativeModel?: string };
  assert.match(report.date, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(report.sessionCount, 0);
  assert.equal(report.narrativeModel, undefined);
  assert.match(report.markdown, /打工日记/u);
  await access(path.join(root, "agent", "agent.sqlite"));
  const status = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    path.resolve("src/cli/index.ts"),
    "activity", "status"
  ], {
    cwd: root,
    env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent") },
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Database: .*agent\.sqlite/u);
  assert.match(status.stdout, /Snapshots: /u);
  const store = new ActivityStore();
  await store.open(path.join(root,"snapshots"),path.join(root,"agent"));
  let sessionId:string;
  try {
    const endedAt = new Date();
    endedAt.setHours(12,10,0,0);
    sessionId=store.startSession(new Date(endedAt.getTime()-10*60_000).toISOString());
    store.recordEvent({sessionId,occurredAt:new Date(endedAt.getTime()-9*60_000).toISOString(),eventType:"app_focus",application:"Editor"});
    store.endSession(sessionId,endedAt.toISOString());
  } finally {await store.close();}
  const analyze = spawnSync(process.execPath,["--import",import.meta.resolve("tsx"),path.resolve("src/cli/index.ts"),
    "activity","analyze",sessionId,"--json"],{cwd:root,env:{...process.env,BINY_AGENT_DIR:path.join(root,"agent")},encoding:"utf8",timeout:15_000});
  assert.equal(analyze.status,0,analyze.stderr);
  assert.ok(["skipped","error"].includes((JSON.parse(analyze.stdout) as {status:string}).status),
    "无可用分析模型时 CLI 返回明确非成功结果");
  const reportAfterAnalyze = spawnSync(process.execPath,["--import",import.meta.resolve("tsx"),path.resolve("src/cli/index.ts"),
    "activity","report","today","--skeleton","--json"],{cwd:root,env:{...process.env,BINY_AGENT_DIR:path.join(root,"agent")},encoding:"utf8",timeout:15_000});
  assert.equal(reportAfterAnalyze.status,0,reportAfterAnalyze.stderr);
  assert.equal((JSON.parse(reportAfterAnalyze.stdout) as {sessionCount:number}).sessionCount,0,
    "无成功分析时日报不把失败会话计入骨架");
  const memory = new MemoryStorage(root, { agentDir: path.join(root, "agent") });
  try {assert.equal((await memory.listEntries()).entries.length,0,"两个 CLI 入口无语义模型时均不写活动记忆");}
  finally {memory.close();}
  let providerCalls = 0;
  const provider = createServer(async (request,response) => {
    providerCalls += 1;
    for await (const _chunk of request) { /* Drain the real provider request body. */ }
    const payload = JSON.stringify({worth:true,title:"Release review",description:"Release checklist review",summary:"Release checklist review",
      memoryCandidates:[{type:"user",content:"Release checklist is required before deployment.",why:"Repeated decision"}]});
    response.writeHead(200,{"content-type":"text/event-stream"});
    response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:payload},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  try {
    const runCli = async (args:string[]):Promise<{status:number|null;stdout:string;stderr:string}> => await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,["--import",import.meta.resolve("tsx"),path.resolve("src/cli/index.ts"),...args],
        {cwd:root,env:{...process.env,BINY_AGENT_DIR:path.join(root,"agent")}});
      let stdout="";let stderr="";
      child.stdout.on("data",data=>{stdout+=String(data);});
      child.stderr.on("data",data=>{stderr+=String(data);});
      const timeout=setTimeout(()=>child.kill("SIGKILL"),30_000);
      child.once("error",error=>{clearTimeout(timeout);reject(error);});
      child.once("close",status=>{clearTimeout(timeout);resolve({status,stdout,stderr});});
    });
    const address = provider.address();
    assert.ok(address && typeof address!=="string");
    await writeFile(path.join(root,"agent","config.json"),JSON.stringify({
      ...defaultConfig,activity:{...defaultConfig.activity,outputDirectory:path.join(root,"snapshots")},defaultModel:"local-test",toolModel:"local-test",
      providers:{local:{type:"openai-compatible",baseUrl:`http://127.0.0.1:${address.port}/v1`,requiresApiKey:false,retry:{maxAttempts:1}}},
      models:{"local-test":{provider:"local",model:"local-test",contextWindow:128000,capabilities:{tools:true,reasoning:false,streaming:true}}}
    }));
    // 恢复入口只重新排队失败记录；既有 analyze 用例无法发现误重放成功分析或入队时调用旧模型。
    const failedStore = new ActivityStore();
    await failedStore.open(path.join(root, "snapshots"), path.join(root, "agent"));
    failedStore.recordAnalysisStatus(sessionId, "failed", { model: "old-model", error: "Insufficient Balance" });
    await failedStore.close();
    const retry = await runCli(["activity", "retry-failed", "--json"]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(JSON.parse(retry.stdout), { queued: 1 });
    assert.equal(providerCalls, 0, "入队不调用模型，后续分析使用最新工具模型配置");
    const successfulAnalyze = await runCli(["activity","analyze",sessionId,"--json"]);
    assert.equal(successfulAnalyze.status,0,successfulAnalyze.stderr);
    const analyzed = JSON.parse(successfulAnalyze.stdout) as { status: string; analysis: { analyzerModel: string } };
    assert.equal(analyzed.status, "analyzed");
    assert.equal(analyzed.analysis.analyzerModel, "local-test", "恢复分析使用新选的工具模型，不继续使用失败模型");
    const retryAfterSuccess = await runCli(["activity", "retry-failed", "--json"]);
    assert.equal(retryAfterSuccess.status, 0, retryAfterSuccess.stderr);
    assert.deepEqual(JSON.parse(retryAfterSuccess.stdout), { queued: 0 }, "成功分析不能重新排队");
    const reportStore = new ActivityStore();
    await reportStore.open(path.join(root,"snapshots"),path.join(root,"agent"));
    let reportSessionId:string;
    try {
      const start = new Date(); start.setHours(12,20,0,0);
      reportSessionId=reportStore.startSession(start.toISOString());
      reportStore.recordEvent({sessionId:reportSessionId,occurredAt:new Date(start.getTime()+60_000).toISOString(),eventType:"app_focus",application:"Editor"});
      reportStore.endSession(reportSessionId,new Date(start.getTime()+10*60_000).toISOString());
    } finally {await reportStore.close();}
    const successfulReport = await runCli(["activity","report","today","--force","--json"]);
    assert.equal(successfulReport.status,0,successfulReport.stderr);
    const verified = new ActivityStore();
    await verified.open(path.join(root,"snapshots"),path.join(root,"agent"));
    try {assert.equal(verified.getHttpSessionDetail(reportSessionId)?.session.analysisStatus,"pending",
      "--force 只刷新日报，不分析新建的会话");}
    finally {await verified.close();}
    const after = new MemoryStorage(root, { agentDir: path.join(root, "agent") });
    try {assert.equal((await after.listEntries()).entries.length,0,"分析成功仍不能绕过缺失的 Activity 语义门禁");}
    finally {after.close();}
  } finally {await new Promise<void>((resolve,reject)=>provider.close(error=>error?reject(error):resolve()));}
} finally {
  await rm(root, { recursive: true, force: true });
}
