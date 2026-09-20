import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPeer, RpcFailure, type RpcMethodSpec, type RpcPeer } from "../src/rpc.ts";
import { parseMessage, type ParsedMessage, type RpcError } from "../src/protocol.ts";

/**
 * 全部纯内存：`write` 是往数组里塞字符串的闭包，`ingest` 手工喂文本。
 * 不碰 process.stdin / stdout，所以「半行」「粘包」「乱序」都能精确构造，
 * 而不是靠运气在真实管道上撞出来。
 */
function harness(methods: Record<string, RpcMethodSpec> = {}, over: Partial<Parameters<typeof createPeer>[0]> = {}) {
  const wire: string[] = [];
  const transportErrors: RpcError[] = [];
  const peer: RpcPeer = createPeer({
    write: (chunk) => void wire.push(chunk),
    // 本端扮演 Node，所以自己的请求走偶数，对面（Swift）走奇数
    idParity: "even",
    methods,
    onTransportError: (e) => void transportErrors.push(e),
    ...over,
  });
  const sent = () => wire.map((l) => parseMessage(l.trimEnd()));
  const lastOf = (kind: ParsedMessage["kind"]) => [...sent()].reverse().find((m) => m.kind === kind);
  return { peer, wire, sent, lastOf, transportErrors };
}

function ok(params: unknown = null): RpcMethodSpec {
  return { handler: () => Promise.resolve(params) };
}

test("rpc: 两个出站调用并发，响应乱序回来也各归各位", async () => {
  const h = harness();
  const a = h.peer.call("ax.observe", { scope: "focusedWindow" });
  const b = h.peer.call("ax.perform", { offerId: "e12" });

  const ids = h.sent().map((m) => (m.kind === "request" ? m.id : null));
  assert.deepEqual(ids, [2, 4], "本端请求必须落在偶数空间");

  // 后发的先回：id 配对不能依赖到达顺序
  h.peer.ingest(`{"id":4,"result":{"who":"b"}}\n`);
  h.peer.ingest(`{"id":2,"result":{"who":"a"}}\n`);
  assert.deepEqual(await a, { who: "a" });
  assert.deepEqual(await b, { who: "b" });
  assert.equal(h.peer.pendingCalls(), 0);
});

test("rpc: 双向——处理入站请求的过程中反过来调对面，拿到结果再回应", async () => {
  const seen: unknown[] = [];
  const h = harness({
    "session.handle": {
      handler: async (params, ctx) => {
        // 这一步就是整个阶段 2 存在的理由：决策到一半反过来要求对面去观察
        const frame = await ctx.call<{ offers: string[] }>("ax.observe", { scope: "focusedWindow" });
        seen.push(params);
        return { status: "done", sawOffers: frame.offers.length };
      },
    },
  });

  h.peer.ingest(`{"id":1,"method":"session.handle","params":{"utterance":"看看当前窗口"}}\n`);
  // 处理器已经把反向请求发出去了，而入站请求还没有回应
  await Promise.resolve();
  await Promise.resolve();
  const outbound = h.sent().find((m) => m.kind === "request");
  assert.ok(outbound && outbound.kind === "request");
  assert.equal(outbound.method, "ax.observe");
  assert.equal(outbound.id % 2, 0);
  assert.equal(h.sent().some((m) => m.kind === "success"), false, "反向调用没回来之前不该先回应");

  h.peer.ingest(`{"id":${outbound.id},"result":{"offers":["e1","e2","e3"]}}\n`);
  await h.peer.drain();

  const reply = h.lastOf("success");
  assert.deepEqual(reply?.kind === "success" ? reply.result : null, { status: "done", sawOffers: 3 });
  assert.deepEqual(seen, [{ utterance: "看看当前窗口" }]);
});

test("rpc: 半行、粘包、空行、CRLF 都能正确切帧", async () => {
  const h = harness({ echo: { handler: (p) => Promise.resolve(p) } });

  // 一行被切成三段喂进来
  h.peer.ingest('{"id":1,"meth');
  h.peer.ingest('od":"echo","par');
  assert.equal(h.wire.length, 0, "半行不该被当成一条消息");
  h.peer.ingest('ams":{"n":1}}\n');
  await h.peer.drain();
  assert.equal(h.wire.length, 1);

  // 粘包：两条消息加一个空行一次喂进来，外加 CRLF 行尾
  h.peer.ingest('{"id":3,"method":"echo","params":{"n":3}}\r\n\n{"id":5,"method":"echo","params":{"n":5}}\n');
  await h.peer.drain();
  const results = h.sent().filter((m) => m.kind === "success").map((m) => (m.kind === "success" ? m.result : null));
  assert.deepEqual(results, [{ n: 1 }, { n: 3 }, { n: 5 }]);
});

test("rpc: 超长行被丢弃并重新对齐，下一条消息照常处理", async () => {
  const h = harness({ echo: { handler: (p) => Promise.resolve(p) } }, { maxLineChars: 64 });
  h.peer.ingest(`{"id":1,"method":"echo","params":{"junk":"${"x".repeat(200)}"`);
  assert.equal(h.transportErrors.at(-1)?.code, "oversized_line");
  // 那条超长行剩下的尾巴要被吞掉，否则后面每一行都会错位
  h.peer.ingest(`}}\n{"id":3,"method":"echo","params":{"n":3}}\n`);
  await h.peer.drain();
  const succ = h.sent().filter((m) => m.kind === "success");
  assert.equal(succ.length, 1);
  assert.deepEqual(succ[0].kind === "success" ? succ[0].result : null, { n: 3 });
});

test("rpc: 读不出来的行回一条传输层错误，连接不受影响", async () => {
  const h = harness({ echo: { handler: (p) => Promise.resolve(p) } });
  h.peer.ingest("这不是 JSON\n");
  assert.equal(h.transportErrors.at(-1)?.code, "parse_error");
  // 认不出 id 只能发通知：编一个 id 回过去会被对面当成某次调用的答案
  const note = h.lastOf("notification");
  assert.equal(note?.kind === "notification" && note.method, "transport.error");

  h.peer.ingest('{"id":1,"method":"echo","params":{"n":1}}\n');
  await h.peer.drain();
  assert.equal(h.lastOf("success")?.kind, "success");
});

test("rpc: 未知 method 回 method_not_found，属方法层，连接仍可用", async () => {
  const h = harness({ echo: { handler: (p) => Promise.resolve(p) } });
  // 阶段 3/4 的方法现在还没有实现，发过来必须如实回这个，而不是断开连接
  h.peer.ingest('{"id":1,"method":"session.confirm","params":{}}\n');
  h.peer.ingest('{"id":3,"method":"ax.observe","params":{}}\n');
  await h.peer.drain();
  const fails = h.sent().filter((m) => m.kind === "failure");
  assert.equal(fails.length, 2);
  for (const f of fails) {
    assert.equal(f.kind === "failure" && f.error.code, "method_not_found");
    assert.equal(f.kind === "failure" && f.error.layer, "method");
  }
  h.peer.ingest('{"id":5,"method":"echo","params":{"n":5}}\n');
  await h.peer.drain();
  assert.equal(h.lastOf("success")?.kind, "success");
});

test("rpc: 通知不产生回应，不认识的通知被静默忽略", async () => {
  const heard: string[] = [];
  const h = harness({}, { onNotification: (m) => void heard.push(m) });
  h.peer.ingest('{"method":"未来才有的通知","params":{"x":1}}\n');
  await h.peer.drain();
  assert.equal(h.wire.length, 0, "通知没有回应");
  assert.deepEqual(heard, ["未来才有的通知"]);
});

test("rpc: 对面用了本端的 id 奇偶 → id_conflict；重复 id → id_conflict", async () => {
  const h = harness({ echo: { handler: () => new Promise(() => {}) } });
  // 偶数是本端的请求空间，对面用它会和本端自己发出去的 id 撞车
  h.peer.ingest('{"id":2,"method":"echo","params":{}}\n');
  assert.equal(h.lastOf("failure")?.kind === "failure" && h.lastOf("failure")!.kind === "failure", true);
  const first = h.sent()[0];
  assert.equal(first.kind === "failure" && first.error.code, "id_conflict");

  // 同一个奇数 id 还在处理中又来一次
  h.peer.ingest('{"id":7,"method":"echo","params":{}}\n');
  h.peer.ingest('{"id":7,"method":"echo","params":{}}\n');
  const last = h.lastOf("failure");
  assert.equal(last?.kind === "failure" && last.error.code, "id_conflict");
});

test("rpc: 对不上号的响应不崩，只报传输层错误", () => {
  const h = harness();
  h.peer.ingest('{"id":2,"result":{"x":1}}\n'); // 偶数但本端没在等
  h.peer.ingest('{"id":3,"result":{"x":1}}\n'); // 奇数，根本不属于本端
  assert.deepEqual(h.transportErrors.map((e) => e.code), ["unknown_response", "unknown_response"]);
});

test("rpc: 出站调用超时后不自动重发", async () => {
  const h = harness();
  const p = h.peer.call("ax.observe", {}, { timeoutMs: 5 });
  await assert.rejects(p, (e: unknown) => e instanceof RpcFailure && e.code === "request_timeout");
  await new Promise((r) => setTimeout(r, 15));
  // 线上只该有一条 ax.observe。自动重发等于替用户多按一次按钮——
  // 对面可能已经做完了副作用，只是回话慢
  assert.equal(h.sent().filter((m) => m.kind === "request").length, 1);
});

test("rpc: close 会把在等的出站调用一次性了结，不留悬空 promise", async () => {
  const h = harness();
  const p = h.peer.call("ax.observe", {});
  h.peer.close("core 要退出了");
  await assert.rejects(p, (e: unknown) => e instanceof RpcFailure && e.code === "peer_gone");
  assert.equal(h.peer.pendingCalls(), 0);
  await assert.rejects(h.peer.call("ax.observe", {}), (e: unknown) => e instanceof RpcFailure && e.code === "peer_gone");
});

// ── 「一个决定最多执行一次」 ────────────────────────────────────────────────

/** 计数用的副作用方法：跑一次就往 log 里记一次，重放不该让它变长。 */
function counting(log: string[], body: (params: Record<string, unknown>) => Promise<unknown> = async () => ({ status: "done" })) {
  return {
    once: true,
    handler: async (params: unknown) => {
      const p = params as Record<string, unknown>;
      log.push(String(p.utterance));
      return body(p);
    },
  } satisfies RpcMethodSpec;
}

test("once: 同一个 requestKey 重发，处理器只跑一次，第二次带 replayed", async () => {
  const log: string[] = [];
  const h = harness({ "session.handle": counting(log) });
  h.peer.ingest('{"id":1,"method":"session.handle","params":{"requestKey":"k1","utterance":"开个标签页"}}\n');
  await h.peer.drain();
  h.peer.ingest('{"id":3,"method":"session.handle","params":{"requestKey":"k1","utterance":"开个标签页"}}\n');
  await h.peer.drain();

  assert.deepEqual(log, ["开个标签页"], "副作用只能发生一次");
  const [a, b] = h.sent().filter((m) => m.kind === "success");
  assert.deepEqual(a.kind === "success" ? a.result : null, { status: "done" });
  assert.deepEqual(b.kind === "success" ? b.result : null, { status: "done", replayed: true });
});

test("once: 在飞的时候重发，挂到同一个 promise 上，不会并起第二次执行", async () => {
  const log: string[] = [];
  let release: (() => void) | null = null;
  const h = harness({
    "session.handle": counting(log, () => new Promise((r) => (release = () => r({ status: "done" })))),
  });

  h.peer.ingest('{"id":1,"method":"session.handle","params":{"requestKey":"k1","utterance":"写笔记"}}\n');
  await Promise.resolve();
  // 第一条还没落定就重发——超时重发的真实形状正是这个
  h.peer.ingest('{"id":3,"method":"session.handle","params":{"requestKey":"k1","utterance":"写笔记"}}\n');
  await Promise.resolve();
  assert.deepEqual(log, ["写笔记"]);

  release!();
  await h.peer.drain();
  const succ = h.sent().filter((m) => m.kind === "success");
  assert.equal(succ.length, 2, "两个请求 id 都要拿到结论");
  assert.deepEqual(log, ["写笔记"], "并发重发也只执行一次");
});

test("once: 不同 requestKey 就该各跑各的——阳性对照，证明去重不是「什么都不执行」", async () => {
  const log: string[] = [];
  const h = harness({ "session.handle": counting(log) });
  h.peer.ingest('{"id":1,"method":"session.handle","params":{"requestKey":"k1","utterance":"第一条"}}\n');
  await h.peer.drain();
  h.peer.ingest('{"id":3,"method":"session.handle","params":{"requestKey":"k2","utterance":"第二条"}}\n');
  await h.peer.drain();
  assert.deepEqual(log, ["第一条", "第二条"]);
});

test("once: 缺 requestKey 一律拒绝，处理器一次都不会被调到", async () => {
  const log: string[] = [];
  const h = harness({ "session.handle": counting(log) });
  for (const params of ['{"utterance":"x"}', '{"requestKey":"","utterance":"x"}', '{"requestKey":123,"utterance":"x"}', "null"]) {
    h.peer.ingest(`{"id":1,"method":"session.handle","params":${params}}\n`);
    await h.peer.drain();
  }
  assert.deepEqual(log, [], "缺省必须等于拦住，不能「先执行了再说」");
  for (const m of h.sent()) assert.equal(m.kind === "failure" && m.error.code, "invalid_params");
});

test("once: 处理器抛错且没声明无副作用 → 重发得到 replay_unavailable，绝不再跑一遍", async () => {
  const log: string[] = [];
  const h = harness({
    "session.handle": counting(log, async () => {
      throw new Error("AppleScript 超时");
    }),
  });
  h.peer.ingest('{"id":1,"method":"session.handle","params":{"requestKey":"k1","utterance":"开标签页"}}\n');
  await h.peer.drain();
  assert.equal(h.lastOf("failure")?.kind === "failure" && h.lastOf("failure")!.kind === "failure", true);

  h.peer.ingest('{"id":3,"method":"session.handle","params":{"requestKey":"k1","utterance":"开标签页"}}\n');
  await h.peer.drain();
  assert.deepEqual(log, ["开标签页"], "炸了也不知道副作用发生没有，重发比报错危险");
  const last = h.lastOf("failure");
  assert.equal(last?.kind === "failure" && last.error.code, "replay_unavailable");
  assert.equal(last?.kind === "failure" && last.error.retriable, false);
});

test("once: 显式声明 sideEffectFree 的失败可以用同一个 key 重来——新旧分支的对照", async () => {
  const log: string[] = [];
  let fail = true;
  const h = harness({
    "session.handle": counting(log, async () => {
      // 校验类失败发生在任何执行之前，什么都没做，键该放回去
      if (fail) throw new RpcFailure("credentials_missing", "缺凭证", { sideEffectFree: true });
      return { status: "done" };
    }),
  });
  h.peer.ingest('{"id":1,"method":"session.handle","params":{"requestKey":"k1","utterance":"搜一下"}}\n');
  await h.peer.drain();
  assert.equal(h.lastOf("failure")?.kind === "failure" && (h.lastOf("failure") as { error: RpcError }).error.code, "credentials_missing");

  fail = false;
  h.peer.ingest('{"id":3,"method":"session.handle","params":{"requestKey":"k1","utterance":"搜一下"}}\n');
  await h.peer.drain();
  assert.deepEqual(log, ["搜一下", "搜一下"], "确实什么都没发生过的键才允许原样再来");
  const last = h.lastOf("success");
  assert.deepEqual(last?.kind === "success" ? last.result : null, { status: "done" });
});

test("once: 结果缓存被挤掉之后只剩墓碑，回 replay_unavailable 而不是悄悄再跑一遍", async () => {
  const log: string[] = [];
  const h = harness({ "session.handle": counting(log) }, { replayCacheSize: 2 });
  for (const k of ["k1", "k2", "k3"]) {
    h.peer.ingest(`{"id":1,"method":"session.handle","params":{"requestKey":"${k}","utterance":"${k}"}}\n`);
    await h.peer.drain();
  }
  // k1 的结果已被挤出缓存，但键还记着
  h.peer.ingest('{"id":3,"method":"session.handle","params":{"requestKey":"k1","utterance":"k1"}}\n');
  await h.peer.drain();
  assert.deepEqual(log, ["k1", "k2", "k3"]);
  const last = h.lastOf("failure");
  assert.equal(last?.kind === "failure" && last.error.code, "replay_unavailable");

  // 阳性对照：还在缓存里的 k3 仍然能正常回放，证明上面那条不是「缓存整个坏了」
  h.peer.ingest('{"id":5,"method":"session.handle","params":{"requestKey":"k3","utterance":"k3"}}\n');
  await h.peer.drain();
  const ok3 = h.lastOf("success");
  assert.equal(ok3?.kind === "success" && (ok3.result as { replayed?: boolean }).replayed, true);
  assert.deepEqual(log, ["k1", "k2", "k3"]);
});

test("once 只作用于声明了 once 的方法：只读方法不需要幂等键", async () => {
  const h = harness({ "session.describe": ok({ protocol: 1 }) });
  h.peer.ingest('{"id":1,"method":"session.describe","params":{}}\n');
  await h.peer.drain();
  assert.deepEqual(h.lastOf("success")?.kind === "success" ? h.lastOf("success")!.kind : null, "success");
});

test("rpc: 结果序列化不了时对面仍然拿得到结论，不会永久挂着", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const h = harness({ boom: { handler: () => Promise.resolve(circular) } });
  h.peer.ingest('{"id":1,"method":"boom","params":{}}\n');
  await h.peer.drain();
  const last = h.lastOf("failure");
  assert.equal(last?.kind === "failure" && last.error.code, "internal_error");
});

/**
 * RPC 这一层不落盘。
 *
 * 留痕是这个项目最大的隐私面，而 RPC 是一条新的消息通道：一旦这三个文件里出现
 * 任何写盘，就必须同时去 `redact.ts` 加 phase 规则，忘了加会静默泄露。
 * 本轮的选择是**不新增落盘面**，所以这条断言守的是那个选择本身。
 */
test("rpc/protocol/session 三个文件都不写盘（配阳性对照，证明这次搜索真的在工作）", async () => {
  const writes = /openJournal|appendFile|writeFile|createWriteStream/;
  for (const f of ["src/rpc.ts", "src/protocol.ts", "src/session.ts"]) {
    assert.equal(writes.test(await readFile(f, "utf8")), false, `${f} 不该有落盘`);
  }
  // 阳性对照：同一个正则在真的落盘的文件上必须命中。否则「三个文件都干净」
  // 可能只是因为正则根本不匹配任何东西
  assert.equal(writes.test(await readFile("src/journal.ts", "utf8")), true);
  assert.equal(writes.test(await readFile("src/cli.ts", "utf8")), true);
});
