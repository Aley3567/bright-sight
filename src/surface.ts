import { loadSurface, type Surface } from "./actions.ts";
import { isAllowedApp } from "./config.ts";
import { executableIds } from "./scripts.ts";
import { TASK_ACTIONS, type ActionSpec, type TaskAction } from "./types.ts";

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
};

export type OfferSet = {
  offers: Offer[];
  /** id → 动作面里的原始 spec。任务层动作不在其中。 */
  specs: Map<string, ActionSpec>;
  /** 本轮允许的选项 id，policy 用它做答案校验。 */
  ids: string[];
  /** 全量动作面规模，留痕用：它是"没有为任何应用写适配代码"的量化证据。 */
  total: number;
};

/** 任务层动作排在最后：真实动作先出现，模型不至于一上来就想收手。 */
function taskOffers(): Offer[] {
  return (Object.keys(TASK_ACTIONS) as TaskAction[]).map((id) => ({ id, summary: TASK_ACTIONS[id] }));
}

export function offersFrom(surface: Surface): OfferSet {
  const allowed = new Set(executableIds());
  const specs = new Map<string, ActionSpec>();
  const offers: Offer[] = [];

  for (const a of surface.actions) {
    if (!allowed.has(a.id)) continue;
    // 白名单查两个独立条件：注册表有模板，且应用在白名单内。
    // 两者由不同的表维护，改错一个另一个还拦得住。
    if (!isAllowedApp(a.app)) continue;
    if (specs.has(a.id)) continue;
    specs.set(a.id, a);
    const ps = a.params.map((p) => p.name).join("、");
    offers.push({ id: a.id, summary: ps ? `${a.summary}（参数：${ps}）` : a.summary });
  }

  offers.push(...taskOffers());
  return { offers, specs, ids: offers.map((o) => o.id), total: surface.actions.length };
}

/** 取本轮选项集。动作面走磁盘缓存，一次 run 只建一次。 */
export async function loadOffers(opts: { cacheDir?: string } = {}): Promise<OfferSet> {
  return offersFrom(await loadSurface(opts));
}
