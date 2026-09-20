import { loadSurface, type Surface } from "./actions.ts";
import { axCapabilityFor, stricterEffect, stricterRisk, type AxActionOffer, type AxOperation } from "./ax.ts";
import { isAllowedApp } from "./config.ts";
import { capabilityEffectOf, executableIds, templateOf } from "./scripts.ts";
import { TASK_ACTIONS, type AxActionSpec, type ScriptActionSpec, type TaskAction } from "./types.ts";

/**
 * 把"系统里存在什么动作"（actions.ts 的解析结果）收窄成"本轮允许模型选什么"。
 *
 * 解析与策略分开是有意的：actions.ts 照样把全机 571 个动作原样解析出来——
 * 那是"动作面从系统自己长出来"这条立意的证据，不能因为本轮只用两个就把它删掉。
 * 收窄发生在这里，而且是允许清单：不在 scripts.ts 注册表里的动作根本不进选项集。
 *
 * 这样 Chrome 的 `execute`（执行任意 JavaScript）不是"被标记为危险"，
 * 而是模型压根看不见它。黑名单的失败模式是"没想到的都放行"，
 * 而动作面是自动生成的，我们无法预先枚举系统会长出什么命令。
 */

export type Offer = {
  id: string;
  /** 给模型看的一句话。任务层动作和真实动作在这里是平的，模型一次选完。 */
  summary: string;
  /**
   * 只有 AX offer 带这个字段：它属于哪一类操作。
   *
   * judge 靠它把 action head 折叠成「每种 operation 一个代表项」，再为每种 operation 建一个
   * target head。省略等于「普通候选」（脚本动作与任务层动作）——它们没有 operation 这一维。
   * 放在这里而不是让 judge 去解析 summary，是因为 summary 是给人看的措辞，随时可能改，
   * 拿它当结构化字段用，改一次措辞就会静默地把分组弄错。
   */
  operation?: AxOperation;
};

/**
 * 一次 `ax.observe` 结果的收窄视图。
 *
 * `offers` 原样保留，不在这里裁剪或重排——收窄发生在 `offersFrom` 里，
 * 与脚本动作走同一条「允许清单」路径。`app` 由调用方从本地快照填，
 * 不取自远端：远端给的是一棵它自己解读过的树，而"现在前台是谁"这件事我们自己看得见。
 */
export type AxFrameView = {
  frameId: string;
  pid: number;
  /** 前台应用名，取自本地快照的 `snapshot.front`。 */
  app: string;
  offers: AxActionOffer[];
};

export type OfferSet = {
  offers: Offer[];
  /** id → 脚本动作的原始 spec。任务层动作与 AX 动作不在其中。 */
  specs: Map<string, ScriptActionSpec>;
  /** id → AX 动作的 spec。与 `specs` 分开：两类动作的生命周期与执行路径都不同。 */
  axSpecs: Map<string, AxActionSpec>;
  /** 本轮允许的选项 id，policy 用它做答案校验。两类动作的 id 都在里面。 */
  ids: string[];
  /** 全量动作面规模，留痕用：它是"没有为任何应用写适配代码"的量化证据。 */
  total: number;
};

/** 任务层动作排在最后：真实动作先出现，模型不至于一上来就想收手。 */
function taskOffers(): Offer[] {
  return (Object.keys(TASK_ACTIONS) as TaskAction[]).map((id) => ({ id, summary: TASK_ACTIONS[id] }));
}

/**
 * 把一条 AX offer 转成模型看得懂的选项说明。
 *
 * 不带 app 名是因为 `AxActionSpec.app` 已经在回答"这是谁的界面"，而同一份动作面里
 * 脚本与 AX 常常属于不同应用，把 app 塞进 summary 会让模型以为在挑应用。
 * 标签为空时退到 role——role 是系统给的，永远有值。
 */
function axOfferSummary(o: AxActionOffer): string {
  const label = o.target.label.trim();
  const base = `AX ${o.operation}：${label || o.target.role}`;
  // 区分文字只在撞名时才有值，所以这里不需要再判一次「要不要加」——Swift 已经判过了。
  // 它落在 summary 而不是 state 里，是因为 summary 就是模型那道单选题里每个选项的说明文字，
  // 也就是官方说的 criteria：要区分两个选项，描述得挂在选项上，不是堆在题干里。
  const context = o.target.context?.trim();
  return context ? `${base}（${context}）` : base;
}

/**
 * 合并两类动作面：脚本动作在前、AX offers 在后、任务层动作仍在最后。
 *
 * 顺序即语义：脚本动作是冻结的、精确匹配的，AX offers 是每次观察现铸的、临时的。
 * 脚本在前，模型先看到"这台机器确定会做什么"，再看"此刻界面上还能做什么"。
 *
 * 不传 `axFrame` 时输出与引入 AX 之前逐字段相等——这条有测试钉住（`test/surface.test.ts`），
 * 因为"降级成只有脚本动作"正是 `observeAX` 失败时的正常路径（见 `cli.ts`）。
 */
export function offersFrom(surface: Surface, axFrame?: AxFrameView): OfferSet {
  const allowed = new Set(executableIds());
  const specs = new Map<string, ScriptActionSpec>();
  const axSpecs = new Map<string, AxActionSpec>();
  const offers: Offer[] = [];

  for (const a of surface.actions) {
    if (!allowed.has(a.id)) continue;
    // 白名单查两个独立条件：注册表有模板，且应用在白名单内。
    // 两者由不同的表维护，改错一个另一个还拦得住。
    if (!isAllowedApp(a.app)) continue;
    if (specs.has(a.id)) continue;
    // effect 以冻结模板为准：sdef 只有动词，模板作者知道后果（见 actions.ts 的 scriptEffectOf）
    const template = templateOf(a.id);
    if (!template) continue;
    specs.set(a.id, { ...a, kind: "script", effect: capabilityEffectOf(template.effect) });
    const ps = a.params.map((p) => p.name).join("、");
    offers.push({ id: a.id, summary: ps ? `${a.summary}（参数：${ps}）` : a.summary });
  }

  if (axFrame) {
    for (const o of axFrame.offers) {
      // 先认领者胜：脚本 id 与 AX offerId 此刻不会撞，但撞了要按 capability.ts 的
      // ADAPTERS 顺序让脚本赢，否则同一个 id 会同时以两种执行路径出现。
      if (specs.has(o.id) || axSpecs.has(o.id)) continue;
      // effect/risk 不信任远端：按 operation + role + editable 自算，与 Swift 标签不符取更严的一侧
      const cap = axCapabilityFor(o.operation, o.target.role, o.target.state.editable);
      const spec: AxActionSpec = {
        kind: "ax",
        id: o.id,
        app: axFrame.app,
        summary: axOfferSummary(o),
        params: [],
        risk: stricterRisk(cap.risk, o.risk),
        effect: stricterEffect(cap.effect, o.effect),
        frameId: axFrame.frameId,
        operation: o.operation,
      };
      axSpecs.set(o.id, spec);
      offers.push({ id: o.id, summary: spec.summary, operation: o.operation });
    }
  }

  offers.push(...taskOffers());
  return { offers, specs, axSpecs, ids: offers.map((o) => o.id), total: surface.actions.length };
}

/** 取本轮选项集。动作面走磁盘缓存，一次 run 只建一次。 */
export async function loadOffers(opts: { cacheDir?: string } = {}): Promise<OfferSet> {
  return offersFrom(await loadSurface(opts));
}
