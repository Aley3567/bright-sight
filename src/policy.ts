import { isAllowedApp } from "./config.ts";
import type { ScriptTemplate } from "./scripts.ts";
import { isTaskAction, type ActionSpec, type Judgement } from "./types.ts";

/**
 * 策略层：把一个带概率的判断变成"要不要真发出去"。
 *
 * 这一层零 IO、零网络、纯函数，因为它是安全边界——安全边界必须能被穷举测试，
 * 而能被穷举测试的前提是它不依赖外部世界。
 */

/**
 * 执行阈值。
 *
 * 这些数字是策略不是常量：它们应当在标注评测集上按"误执行代价"调出来，
 * 而不是凭手感定死。当前值是初始猜测，校准评测跑完后要用实测结果替换。
 */
export const THRESHOLDS = {
  /** 低于此置信度不执行，转为向用户澄清。 */
  execute: 0.75,
  /** 指令完整度低于此值说明用户还在说，继续等下一段转写。 */
  complete: 0.6,
  /** 模型判定的破坏性概率超过此值即需人工确认，与动作面固定的 risk 取并集。 */
  destructive: 0.3,
} as const;

/**
 * 五态。
 *
 * execute 之外的四态都不产生副作用，这是本模块唯一需要被记住的性质：
 * 只有一条路通向真实的 Apple Event。
 */
export type PolicyKind = "execute" | "confirm" | "ask" | "wait" | "ignore";

export type PolicyResult = {
  kind: PolicyKind;
  /** 要执行 / 待确认的动作 id；其余态为 null。 */
  actionId: string | null;
  /** 为什么是这个结论，人读的。每一条判据都留痕，事后不用猜。 */
  reasons: string[];
};

export type PolicyInput = {
  judgement: Judgement;
  /** 本轮真正给过模型的选项。模型答了没给过的东西一律作废。 */
  offered: readonly string[];
  /** 动作面里那条 spec，携带构建期固定的 risk。 */
  spec?: ActionSpec;
  /** 执行模板。没有模板就没有执行路径。 */
  template?: ScriptTemplate;
};

/**
 * 三道独立硬闸，取或。
 *
 * 代码里不存在任何路径让模型的概率**降低**拦截强度——模型的 destructive
 * 只能把 safe 的动作抬进 confirm，不能把 destructive 的动作放行。
 * 这一条可以被属性测试穷举：spec.risk === "destructive" 时 policy 必然 confirm。
 */
function hardBlocked(input: PolicyInput): string[] {
  const { judgement: j, spec, template } = input;
  const hits: string[] = [];
  // 第一道：动作面构建期固定的风险，模型碰不到
  if (spec?.risk === "destructive") hits.push(`动作面把 ${spec.id} 标为破坏性`);
  // 第二道：模型只能加，不能减
  if (j.destructive > THRESHOLDS.destructive) {
    hits.push(`模型判定破坏性 ${j.destructive.toFixed(2)} 超过阈值 ${THRESHOLDS.destructive}`);
  }
  // 第三道：模板自带，抓 sdef 误标——sdef 的动词名不足以判断后果，模板作者知道
  if (template?.effect === "destroy") hits.push(`模板 ${template.id} 声明了破坏性副作用`);
  return hits;
}

export function policy(input: PolicyInput): PolicyResult {
  const { judgement: j, offered, spec, template } = input;
  const id = j.action;

  // 答案校验先行：模型答了没给过的选项，整条判断作废，绝不因此产生任何动作
  if (!offered.includes(id)) {
    return { kind: "ignore", actionId: null, reasons: [`模型返回了未提供的选项 ${JSON.stringify(id)}`] };
  }

  // 硬闸优先于一切非法性之外的判断：破坏性不能被"还没说完"之类的理由绕过
  const blocks = hardBlocked(input);
  if (blocks.length > 0) return { kind: "confirm", actionId: id, reasons: blocks };

  if (isTaskAction(id)) {
    if (id === "ASK") return { kind: "ask", actionId: null, reasons: ["模型认为信息不足，需要追问"] };
    if (id === "WAIT") return { kind: "wait", actionId: null, reasons: ["模型认为上一步尚未生效"] };
    // DONE / BLOCKED / UNSUPPORTED 都是终止意图，由 loop 决定怎么收尾，policy 只负责不产生副作用
    return { kind: "ignore", actionId: id, reasons: [`模型给出终止意图 ${id}`] };
  }

  if (j.complete < THRESHOLDS.complete) {
    return { kind: "wait", actionId: null, reasons: [`指令完整度 ${j.complete.toFixed(2)} 低于 ${THRESHOLDS.complete}`] };
  }

  // 白名单与模板各查一次，两个条件独立：surface 放错了，这里仍然拦得住
  if (!spec) return { kind: "ignore", actionId: id, reasons: [`动作面里没有 ${id}`] };
  if (!isAllowedApp(spec.app)) {
    return { kind: "ignore", actionId: id, reasons: [`${spec.app} 不在执行白名单内`] };
  }
  if (!template) {
    return { kind: "ignore", actionId: id, reasons: [`${id} 没有执行模板，本轮不支持执行它`] };
  }

  if (j.confidence < THRESHOLDS.execute) {
    return { kind: "ask", actionId: id, reasons: [`置信度 ${j.confidence.toFixed(2)} 低于 ${THRESHOLDS.execute}，先问清楚`] };
  }

  return {
    kind: "execute",
    actionId: id,
    reasons: [`置信度 ${j.confidence.toFixed(2)}、完整度 ${j.complete.toFixed(2)}，静态风险 ${spec.risk}`],
  };
}
