import { CHROME_APP, isAllowedApp } from "./config.ts";
import type { ScriptTemplate } from "./scripts.ts";
import { isTaskAction, type ActionSpec, type FreshnessMark, type Judgement, type ProfileGate, type Snapshot } from "./types.ts";

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
  /**
   * Chrome profile 闸门状态，由 chrome.ts 探测后传进来。
   *
   * **省略等于 undetectable，不等于放行。** 这个默认值是刻意的：调用方忘了探测，
   * 结果应该是「停下来问人」而不是「静默发到某个不知道是谁的登录态里」。
   * 安全边界的缺省值必须站在保守那一边。
   */
  profile?: ProfileGate;
};

/**
 * 四道独立硬闸，取或。
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
  // 第四道：AX 动作的写档一律要人拍板。
  //
  // AX 动作没有模板，第三道对它恒不触发；而它的 risk 是 Node 自算出来的兜底档
  // （认不出的组合固定是 change/caution），拿它当唯一判据等于「认得出才拦、认不出就放行」。
  // 所以这里直接按 effect 判档，不绕道 risk：change/submit/destroy 都是会改变
  // 用户界面的动作，即便是「受控窗口」也不自动执行——这是刻意的选择，接通之后
  // 点任何按钮都要人点头。
  if (spec?.kind === "ax" && (spec.effect === "change" || spec.effect === "submit" || spec.effect === "destroy")) {
    hits.push(`AX 动作 ${spec.id} 会改动界面（${spec.effect}），需要当场确认`);
  }
  return hits;
}

/**
 * 第四道闸：Chrome 动作必须落在人确认过的 profile 上。
 *
 * 只对 Chrome 生效——profile 是 Chrome 独有的概念，给 Notes 套这条判据毫无意义。
 * 返回拦截理由，或 null 表示放行。
 *
 * 值得记一笔的是这条闸为什么不能做成「自动切到正确的 profile」：Chrome 的脚本字典里
 * 根本没有 profile 命令，AppleScript 侧无从选择。能做的只有先看清楚要落在哪，
 * 陌生就停下来问。
 */
function profileBlock(app: string, gate: ProfileGate | undefined): string | null {
  if (app !== CHROME_APP) return null;
  const g = gate ?? { kind: "undetectable" as const, detail: "调用方没有提供 profile 探测结果" };
  if (g.kind === "allowed") return null;
  // dry-run 这一轮不会发出任何 Apple Event，也就无所谓落在谁的登录态里。
  // 拦住它的唯一效果是让人连 argv 都看不到，而看见完整 argv 正是 dry-run 存在的理由。
  if (g.kind === "dry-run") return null;
  if (g.kind === "unknown") return `Chrome profile ${g.dir} 不在允许名单内，需要当场确认`;
  return `探测不到当前 Chrome profile（${g.detail}），不能确定会落在谁的登录态里`;
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

  if (!spec) return { kind: "ignore", actionId: id, reasons: [`动作面里没有 ${id}`] };

  // 按 kind 分流，没有第三支兜底放行。两类动作的判据依据不同的表：
  // 脚本动作问「在不在执行白名单、有没有冻结模板、会落在哪个 Chrome profile」，
  // 这三个问题对 AX 动作要么恒真要么无意义（AX 不发 Apple Event，也不认 Chrome profile 这个概念）。
  // 缺省值一律 fail-closed：这里没有 `else` 放行的写法，两个分支各自必须给出结论。
  if (spec.kind === "ax") {
    // AX 判据只有「该不该做」这一问，静态档已经由 hardBlocked 的第四道闸拦过。
    // 剩下的判据与脚本动作共用同一个置信度门槛。
    if (j.confidence < THRESHOLDS.execute) {
      return { kind: "ask", actionId: id, reasons: [`置信度 ${j.confidence.toFixed(2)} 低于 ${THRESHOLDS.execute}，先问清楚`] };
    }
    return {
      kind: "execute",
      actionId: id,
      reasons: [`置信度 ${j.confidence.toFixed(2)}、完整度 ${j.complete.toFixed(2)}，AX 动作 ${spec.operation}`],
    };
  }

  // 白名单与模板各查一次，两个条件独立：surface 放错了，这里仍然拦得住
  if (!isAllowedApp(spec.app)) {
    return { kind: "ignore", actionId: id, reasons: [`${spec.app} 不在执行白名单内`] };
  }
  if (!template) {
    return { kind: "ignore", actionId: id, reasons: [`${id} 没有执行模板，本轮不支持执行它`] };
  }

  if (j.confidence < THRESHOLDS.execute) {
    return { kind: "ask", actionId: id, reasons: [`置信度 ${j.confidence.toFixed(2)} 低于 ${THRESHOLDS.execute}，先问清楚`] };
  }

  // 第四道闸放在最后：前面几道回答「这件事该不该做」，这一道回答「在谁的登录态里做」。
  // 顺序反过来的话，一个置信度过低的动作会先因为 profile 被问成 confirm，
  // 人看到的提示就成了「要不要在某某 profile 下执行」，而真正的问题是模型根本没想清楚。
  //
  // 它只对脚本动作生效：profile 是「这次 Apple Event 会落到哪个 Chrome profile」，
  // AX 路径根本不发 Apple Event，套上它只会让 AX 动作凭空多出一大片确认气泡。
  const gate = profileBlock(spec.app, input.profile);
  if (gate) return { kind: "confirm", actionId: id, reasons: [gate] };

  return {
    kind: "execute",
    actionId: id,
    reasons: [`置信度 ${j.confidence.toFixed(2)}、完整度 ${j.complete.toFixed(2)}，静态风险 ${spec.risk}`],
  };
}

// ── 挂起与恢复之间的那段时间 ────────────────────────────────────────────────

/**
 * 把「此刻的世界」压成一份可比对的指纹。
 *
 * 放在 policy.ts 而不是 loop.ts，理由和上面四道闸一样：这是安全判据，
 * 而安全判据要能被穷举测试，前提是它不依赖外部世界。这里只做投影，不做 IO——
 * 快照由调用方观察好了传进来。
 */
export function freshnessMark(snapshot: Snapshot, gate: ProfileGate | undefined): FreshnessMark {
  return { front: snapshot.front, window: snapshot.window, profile: gateIdentity(gate) };
}

/**
 * profile 闸门的身份串。
 *
 * 比的是「凭什么放行」的整体，不只是目录名：`unknown:Default` 与 `allowed:Default`
 * 是两回事，前者要问人、后者不用。省略等于 `undetectable`，与 `profileBlock` 同一个缺省。
 */
function gateIdentity(gate: ProfileGate | undefined): string {
  const g = gate ?? { kind: "undetectable" as const, detail: "" };
  if (g.kind === "allowed") return `allowed:${g.dir}`;
  if (g.kind === "unknown") return `unknown:${g.dir}`;
  if (g.kind === "dry-run") return "dry-run";
  return "undetectable";
}

export type Staleness = {
  /** 判据名。是代码常量，可以进留痕。 */
  field: "front" | "window" | "profile";
  /** 给人看的一句话。**不要写进留痕**——它会带上窗口标题或 profile 目录名。 */
  detail: string;
};

export type FreshnessInput = {
  /** 挂起那一刻记下的。 */
  mark: FreshnessMark;
  /** 恢复这一刻重新观察出来的。 */
  now: FreshnessMark;
  /**
   * 待执行动作归属的应用。
   *
   * **省略等于「不知道是谁」，于是每条判据都适用**，包括只对 Chrome 有意义的 profile。
   * 缺省放宽的话，一个查不到 spec 的动作就正好绕开了这道闸。
   */
  app?: string;
};

/**
 * 挂起期间世界变了没有。空数组 = 没变，可以按挂起时的决定继续。
 *
 * 为什么 front 与 window 也算数，哪怕今天这两个动作（开标签页、记笔记）都不读它们：
 * 用户说「好」时同意的是**他当时看到的那件事**。窗口换了就说明他看到的那个世界
 * 已经不在了，此时执行的是一个没人真正批准过的动作。这条判据宁可误伤——
 * 误伤的代价是用户再说一遍，放过的代价是在错误的世界里发出真实的 Apple Event。
 *
 * profile 只对 Chrome 生效，与 `profileBlock` 保持同一个作用域：给 Notes 套这条毫无意义，
 * 只会让「切了个 Chrome 窗口」把一条笔记也拦下来。
 */
export function staleness(input: FreshnessInput): Staleness[] {
  const { mark, now } = input;
  const out: Staleness[] = [];
  if (mark.front !== now.front) {
    out.push({ field: "front", detail: `前台应用从 ${mark.front} 变成了 ${now.front}` });
  }
  if (mark.window !== now.window) {
    out.push({ field: "window", detail: `前台窗口标题从 ${mark.window ?? "（无）"} 变成了 ${now.window ?? "（无）"}` });
  }
  if ((input.app ?? CHROME_APP) === CHROME_APP && mark.profile !== now.profile) {
    out.push({ field: "profile", detail: `Chrome profile 闸门从 ${mark.profile} 变成了 ${now.profile}` });
  }
  return out;
}
