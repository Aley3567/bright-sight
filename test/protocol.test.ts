import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  RPC_ERRORS,
  encodeMessage,
  makeRpcError,
  parityOf,
  parseMessage,
  type RpcErrorCode,
} from "../src/protocol.ts";

test("protocol: 四种消息各自认得出来", () => {
  const req = parseMessage('{"id":1,"method":"session.handle","params":{"utterance":"x"}}');
  assert.equal(req.kind, "request");
  assert.equal(req.kind === "request" && req.method, "session.handle");

  const ok = parseMessage('{"id":2,"result":{"status":"done"}}');
  assert.equal(ok.kind, "success");

  const bad = parseMessage('{"id":3,"error":{"code":"invalid_params","layer":"method","message":"m","retriable":false}}');
  assert.equal(bad.kind, "failure");
  assert.equal(bad.kind === "failure" && bad.error.code, "invalid_params");

  const note = parseMessage('{"method":"server.ready","params":{"protocol":1}}');
  assert.equal(note.kind, "notification");
});

test("protocol: 畸形消息各自有说法，能认出 id 的就带上 id", () => {
  // 认不出 id 的三种：id 只能靠通知回报，不能凭空编一个回应
  for (const line of ["{", "[1,2,3]", '"字符串"', '{"id":0,"method":"m"}', '{"id":1.5,"method":"m"}', '{"id":-1,"method":"m"}', '{"foo":1}']) {
    const m = parseMessage(line);
    assert.equal(m.kind, "invalid", line);
    assert.equal(m.kind === "invalid" && m.id, null, line);
  }
  // 同时带 result 和 error 是畸形。不挑一个用——挑一个等于替对面猜它想说什么
  const both = parseMessage('{"id":4,"result":1,"error":{"code":"internal_error","message":"m"}}');
  assert.equal(both.kind, "invalid");
  assert.equal(both.kind === "invalid" && both.id, 4);

  const naked = parseMessage('{"id":6}');
  assert.equal(naked.kind, "invalid");
  assert.equal(naked.kind === "invalid" && naked.id, 6);
});

test("protocol: 对面发来读不懂的 error 会被归一化，而不是让本端崩掉", () => {
  const m = parseMessage('{"id":8,"error":{"code":"某个我们没有的码","message":"哦"}}');
  assert.equal(m.kind, "failure");
  assert.equal(m.kind === "failure" && m.error.code, "malformed_message");
  assert.equal(m.kind === "failure" && m.error.message, "哦");
});

test("protocol: 错误分层——传输层与方法层齐全，业务结局不在这张表里", () => {
  const layers = new Set(Object.values(RPC_ERRORS).map((d) => d.layer));
  assert.deepEqual([...layers].sort(), ["method", "transport"]);

  // 阳性对照：先证明这张表查得动。不然下面那条「业务结局不在表里」全绿也说明不了什么
  assert.ok(Object.hasOwn(RPC_ERRORS, "invalid_params"));
  assert.equal(RPC_ERRORS.invalid_params.layer, "method");
  assert.equal(RPC_ERRORS.parse_error.layer, "transport");
  // 真正要守的：blocked / needs_input 是 result 里的 status，不是 error。
  // 混进来的话 Swift 只能显示「出错了」，而真实原因是「我不会做这件事」
  for (const status of ["blocked", "needs_input", "done", "waiting_for_confirmation"]) {
    assert.equal(Object.hasOwn(RPC_ERRORS, status), false, status);
  }
});

test("protocol: 只有超时是 retriable——幂等键让它安全，其余重发没有意义", () => {
  const retriable = (Object.keys(RPC_ERRORS) as RpcErrorCode[]).filter((c) => RPC_ERRORS[c].retriable);
  assert.deepEqual(retriable, ["request_timeout"]);
  // replay_unavailable 的含义正是「已经执行过了，别再发」
  assert.equal(RPC_ERRORS.replay_unavailable.retriable, false);
});

test("protocol: makeRpcError 自动补层与 retriable，可被逐条覆盖", () => {
  const e = makeRpcError("method_not_found", "没这个方法");
  assert.deepEqual(e, { code: "method_not_found", layer: "method", message: "没这个方法", retriable: false });
  assert.equal(makeRpcError("method_not_found", "m", { retriable: true }).retriable, true);
});

test("protocol: 编码永不产生裸换行，正文里的换行被转义", () => {
  const line = encodeMessage({ id: 2, result: { text: "第一行\n第二行\r\n带回车", tab: "\t" } });
  assert.equal(line.endsWith("\n"), true);
  // 阳性对照：确实有换行内容进去了（否则「只有一个 \n」也可能是因为根本没编码上）
  assert.ok(line.includes("\\n"), "正文的换行应当以转义形式出现");
  assert.equal(line.split("\n").length, 2, "整条消息只能占一行");
  assert.deepEqual(parseMessage(line.trimEnd()), {
    kind: "success",
    id: 2,
    result: { text: "第一行\n第二行\r\n带回车", tab: "\t" },
  });
});

test("protocol: result 为 undefined 时落成 null，不会退化成畸形消息", () => {
  const line = encodeMessage({ id: 4, result: undefined });
  assert.equal(line, '{"id":4,"result":null}\n');
  assert.equal(parseMessage(line.trimEnd()).kind, "success");
});

test("protocol: id 空间按奇偶切开", () => {
  assert.equal(parityOf(1), "odd");
  assert.equal(parityOf(2), "even");
  assert.equal(PROTOCOL_VERSION, 1);
});
