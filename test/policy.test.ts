import test from "node:test";
import assert from "node:assert/strict";
import { THRESHOLDS, policy } from "../src/policy.ts";
import { REGISTRY } from "../src/scripts.ts";
import type { ActionSpec, Judgement } from "../src/types.ts";

const NOTE = "Notes.make-note";
const OFFERED = [NOTE, "Google Chrome.make-tab", "ASK", "WAIT", "DONE", "BLOCKED", "UNSUPPORTED"];

function judgement(over: Partial<Judgement> = {}): Judgement {
  return {
    action: NOTE,
    probabilities: { [NOTE]: 0.9 },
    confidence: 0.9,
    complete: 0.9,
    destructive: 0.02,
    backend: "test",
    latency_ms: 1,
    ...over,
  };
}

function spec(over: Partial<ActionSpec> = {}): ActionSpec {
  return { id: NOTE, app: "Notes", summary: "新建笔记", kind: "script", params: [], risk: "safe", ...over };
}

const ok = { offered: OFFERED, spec: spec(), template: REGISTRY[NOTE] };

test("policy: 置信度与完整度都够、白名单内、有模板才放行执行", () => {
  const r = policy({ judgement: judgement(), ...ok });
  assert.equal(r.kind, "execute");
  assert.equal(r.actionId, NOTE);
});

test("policy: 模型返回没给过的选项，整条判断作废且不产生动作", () => {
  const r = policy({ judgement: judgement({ action: "Finder.delete" }), ...ok });
  assert.equal(r.kind, "ignore");
  assert.equal(r.actionId, null, "被作废的判断不许把动作 id 漏给下游");
});

test("policy: 静态风险为 destructive 时必然拦截，模型的低破坏性概率救不了它", () => {
  const r = policy({ judgement: judgement({ destructive: 0 }), ...ok, spec: spec({ risk: "destructive" }) });
  assert.equal(r.kind, "confirm");
});

test("policy: 模型的破坏性概率只能加码，能把 safe 动作抬进确认", () => {
  const r = policy({ judgement: judgement({ destructive: THRESHOLDS.destructive + 0.01 }), ...ok });
  assert.equal(r.kind, "confirm");
});

test("policy: 模板声明 destroy 时拦截，哪怕动作面把它标成 safe", () => {
  const destroy = { ...REGISTRY[NOTE], id: "Notes.delete-note", effect: "destroy" as const };
  const r = policy({ judgement: judgement(), ...ok, template: destroy });
  assert.equal(r.kind, "confirm");
});

test("policy: 硬闸优先于置信度——置信度再低也不会把 destructive 降级成温和的追问", () => {
  const r = policy({ judgement: judgement({ confidence: 0.01, complete: 0.01 }), ...ok, spec: spec({ risk: "destructive" }) });
  assert.equal(r.kind, "confirm", "confirm 要人确认，ask/wait 不要，降级等于放松");
});

test("policy: 白名单外的应用即使有模板也不执行", () => {
  const r = policy({ judgement: judgement(), ...ok, spec: spec({ app: "Finder" }) });
  assert.equal(r.kind, "ignore");
});

test("policy: 动作面有但没有执行模板时不执行", () => {
  const r = policy({ judgement: judgement(), offered: OFFERED, spec: spec(), template: undefined });
  assert.equal(r.kind, "ignore");
  assert.match(r.reasons.join(""), /没有执行模板/);
});

test("policy: 五个任务层动作各自映射到固定的处置", () => {
  const kinds = ["ASK", "WAIT", "DONE", "BLOCKED", "UNSUPPORTED"].map(
    (a) => policy({ judgement: judgement({ action: a }), ...ok }).kind,
  );
  assert.deepEqual(kinds, ["ask", "wait", "ignore", "ignore", "ignore"]);
});

test("policy: 指令没说完时等待，不抢跑", () => {
  const r = policy({ judgement: judgement({ complete: THRESHOLDS.complete - 0.01 }), ...ok });
  assert.equal(r.kind, "wait");
});

test("policy: 置信度不足时转为追问而不是执行", () => {
  const r = policy({ judgement: judgement({ confidence: THRESHOLDS.execute - 0.01 }), ...ok });
  assert.equal(r.kind, "ask");
});

test("policy: 任意随机判断下，destructive 静态风险都不出现一次放行（属性测试）", () => {
  // 线性同余，种子固定——失败可复现，不靠 Math.random 碰运气
  let seed = 20260920;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const actions = [...OFFERED, "Finder.delete", "none", ""];
  for (let i = 0; i < 1000; i++) {
    const j = judgement({
      action: actions[Math.floor(rnd() * actions.length)],
      confidence: rnd(),
      complete: rnd(),
      destructive: rnd(),
    });
    const r = policy({ judgement: j, offered: OFFERED, spec: spec({ risk: "destructive" }), template: REGISTRY[NOTE] });
    // 答案非法时整条作废（ignore，且不产生动作）；只要选项合法，destructive 必然 confirm
    const allowed = OFFERED.includes(j.action) ? "confirm" : "ignore";
    assert.equal(r.kind, allowed, `第 ${i} 个反例: ${JSON.stringify(j)}`);
    assert.notEqual(r.kind, "execute");
  }
});

test("policy: 阈值之间的大小关系没有被改坏", () => {
  assert.ok(THRESHOLDS.execute > THRESHOLDS.complete, "执行门槛应当严于完整度门槛");
  assert.ok(THRESHOLDS.destructive < 0.5, "破坏性阈值必须明显偏保守，宁可多问一次");
});
