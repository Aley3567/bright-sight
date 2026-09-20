import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ActionSpec, Judgement, Snapshot } from "./types.ts";
import { isVerbatim } from "./spans.ts";

/**
 * 决策层：把"当前机器状态 + 用户说的话"变成一个带概率的类型化判断。
 *
 * 这一层刻意定义成可替换后端。System One 模型（Jev）是当前实现，
 * 但闭环不依赖它的任何专有特性——选项集合由我们的动作面生成，
 * 阈值策略、安全闸、验证与留痕都在我们这边。换成任意支持结构化输出的
 * 模型，整个系统照常运行，只是延迟和成本不同。对照实验也靠这个接口。
 */
export interface DecisionBackend {
  readonly name: string;
  /** 一级判断：这句话指向哪个应用、说完整了没有、是不是危险意图。 */
  route(input: RouteInput): Promise<Judgement>;
  /** 二级判断：在选定应用的动作面里选一个具体命令。 */
  pick(input: PickInput): Promise<Judgement>;
}

export type RouteInput = { utterance: string; snapshot: Snapshot; candidates: string[] };
export type PickInput = { utterance: string; snapshot: Snapshot; actions: ActionSpec[] };

/**
 * 决策分两级，不是为了优雅，是被真实约束逼出来的：
 * 本机动作面有 571 个动作，而 Choice 的选项上限是 255。
 * 先在应用维度收敛，再在选定应用的十几个命令里选，两级都远低于上限，
 * 且每级的选项都更同质，概率分布因此更可分。
 */
export const CHOICE_LIMIT = 255;

/** 送进模型的状态要瘦：只保留能影响判断的字段，其余都是白花的 token。 */
function stateOf(s: Snapshot, utterance: string) {
  return {
    用户说: utterance,
    当前应用: s.front,
    当前窗口: s.window ?? "无窗口",
    正在运行的应用: s.running,
    当前窗口可点击的元素: s.elements.map((e) => `${e.role}: ${e.label}`),
    选中的文字: s.selection ?? "无",
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 模型调用的超时与重试：三处 systemOne 调用（route/pick/judge）共用
 * ────────────────────────────────────────────────────────────────────────── */

/** 单次模型调用的超时预算，风格对齐 osa.ts 的 OsaOptions.timeoutMs。 */
const MODEL_TIMEOUT_MS = 25_000;

/** 超过这个次数就认输：429/503/529 都指向"服务端暂时顶不住"，不是永久性故障。 */
const MAX_MODEL_RETRIES = 3;

/**
 * 只重试这三个状态码。其余错误（400/401、凭证缺失、断网）立即抛出——
 * 闷头重试会把配置错误伪装成偶发故障，也会让"应在超时预算内报错"这条
 * 验收失真成"超时预算 × 重试次数"。
 */
const RETRYABLE_STATUS = new Set([429, 503, 529]);

function retryableStatus(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && RETRYABLE_STATUS.has(status);
}

/**
 * 关掉 SDK 自带的重试。
 *
 * SDK 默认 `maxRetries: 2`，对 408/429/500-599 整段都重试，还会
 * `respectRetryAfter` 等到最长 60 s（见 `@typesafe-ai/sdk` 的 `DEFAULT_RETRY_POLICY`）。
 * 不关掉的话会跟 callModel 自己那层重试叠加：次数相乘（最坏情况一次 judge()
 * 打出十余次请求，对被限流的 429 尤其糟），而且 SDK 内部的退避会算在我们
 * 对外承诺的 25 s 超时预算里，导致看到的是超时而不是真实错误。
 *
 * 重试范围也刻意比 SDK 默认窄：只认 429/503/529（服务端"暂时顶不住"），
 * 不包括 SDK 默认覆盖的其余 5xx（比如 500）——那类更可能是这次请求本身
 * 触发了服务端 bug，重试解决不了，只会拖长故障发现时间。重试权全部收归
 * `callModel`，SDK 层必须是 0。
 */
const NO_SDK_RETRY = { maxRetries: 0 } as const;

/** 指数退避等待，可被 signal 提前中止——调用方取消时不该在这里傻等。 */
function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const ms = Math.min(500 * 2 ** attempt, 5000);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 给一次模型调用套上超时与重试。
 *
 * 超时用 AbortController：调用方传入的 signal 与内部计时器必须共用同一个
 * controller，谁先触发就中止请求——只认其中一个的话，调用方主动取消时
 * 请求会傻等到超时预算耗尽才收场，这正是要避免的 bug。
 */
async function callModel<T>(
  attemptOnce: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(outerSignal?.reason);
    if (outerSignal?.aborted) onAbort();
    else outerSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`模型调用超过 ${MODEL_TIMEOUT_MS}ms`)),
      MODEL_TIMEOUT_MS,
    );
    try {
      return await attemptOnce(controller.signal);
    } catch (err) {
      // 调用方主动取消：这是"不要了"，不是"再试一次"
      if (outerSignal?.aborted || attempt >= MAX_MODEL_RETRIES || !retryableStatus(err)) {
        throw err;
      }
      await backoff(attempt, outerSignal);
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onAbort);
    }
  }
}

export class JevBackend implements DecisionBackend {
  readonly name = "jev";
  private client: TypeSafeClient;

  constructor(client?: TypeSafeClient) {
    // 凭证由 SDK 从 TYPESAFE_API_KEY 读取，本模块不接触密钥本身
    this.client = client ?? new TypeSafeClient();
  }

  async route({ utterance, snapshot, candidates }: RouteInput): Promise<Judgement> {
    const t0 = Date.now();
    const opts: Record<string, string | null> = {};
    for (const app of candidates.slice(0, CHOICE_LIMIT - 1)) opts[app] = null;
    opts["none"] = "这句话没有指向任何具体应用，或还听不出意图";

    // 三个问题一次问完：它们互相独立，分开问只会多付两次往返
    const r = await callModel((signal) =>
      this.client.systemOne(
        {
          state: stateOf(snapshot, utterance),
          questions: {
            app: choice("用户这句话想操作哪个应用？", opts),
            complete: noul("这句话已经把要做的事说完整了吗？还在半句中途则为否。"),
            destructive: noul("这句话要求删除、清空或销毁数据吗？"),
          },
        },
        { signal, timeout: MODEL_TIMEOUT_MS, retry: NO_SDK_RETRY },
      ),
    );

    const a = r.answers.app;
    return {
      action: a.choice,
      probabilities: a.probabilities ?? {},
      confidence: a.confidence ?? 0,
      complete: r.answers.complete.noul,
      destructive: r.answers.destructive.noul,
      backend: this.name,
      latency_ms: Date.now() - t0,
    };
  }

  async pick({ utterance, snapshot, actions }: PickInput): Promise<Judgement> {
    const t0 = Date.now();
    const opts: Record<string, string | null> = {};
    for (const a of actions.slice(0, CHOICE_LIMIT - 1)) {
      const ps = a.params.map((p) => p.name).join("、");
      opts[a.id] = ps ? `${a.summary}（参数：${ps}）` : a.summary;
    }
    opts["none"] = "这些命令里没有一个符合用户的意图";

    const r = await callModel((signal) =>
      this.client.systemOne(
        {
          state: stateOf(snapshot, utterance),
          questions: {
            action: choice("应该执行哪一个命令来完成用户的要求？", opts),
            destructive: noul("执行这个命令会不可逆地删除或覆盖用户的数据吗？"),
          },
        },
        { signal, timeout: MODEL_TIMEOUT_MS, retry: NO_SDK_RETRY },
      ),
    );

    const a = r.answers.action;
    return {
      action: a.choice,
      probabilities: a.probabilities ?? {},
      confidence: a.confidence ?? 0,
      complete: 1,
      destructive: r.answers.destructive.noul,
      backend: this.name,
      latency_ms: Date.now() - t0,
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 单 head 扁平决策：本轮闭环实际走的路径
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 为什么是单 head 而不是上面那套两级？
 *
 * 两级是被 Choice 的 255 选项上限逼出来的——全机 751 个动作装不进一次提问。
 * 但执行允许清单把本轮选项压到了 7 个，上限约束消失，第二级也就没有存在理由了。
 * 而且"该收手了"和"该执行下一步了"本来就是同一个判断，分两次问，
 * 模型得在不知道能不能收手的前提下选动作。两级接口保留给 probe 和 Phase 3。
 */

export type BodySource = { key: string; hint: string };

export type JudgeInput = {
  utterance: string;
  snapshot: Snapshot;
  offers: readonly { id: string; summary: string }[];
  /** 从用户原话切出的候选片段，模型只能在这里面挑，不能生成。 */
  spans: readonly string[];
  /** 可作为笔记正文的来源：上一步的产物，或某个原话片段。 */
  bodySources: readonly BodySource[];
  /** 已完成步骤的摘要，让模型知道自己走到哪了。 */
  history: readonly string[];
};

export type Decision = {
  judgement: Judgement;
  /** 模型挑中的原话片段。null 表示没问、没挑，或挑了个不合法的。 */
  span: string | null;
  /** 正文来源 key。null 同上。 */
  bodySource: string | null;
  /** 答案校验失败的原因；非空时 policy 会把整条判断作废。 */
  violations: string[];
};

/** 概率分布的容差。和明显偏离 1 说明返回的不是一个分布，整条答案不可信。 */
const PROB_SUM_TOLERANCE = 0.05;

type ChoiceLike = { choice: string; confidence: number; probabilities: Record<string, number> };

/**
 * 动态构建的 questions 会让答案退化成宽类型，SDK 的 const 泛型推断在这里帮不上忙。
 * 与其到处写断言，不如在边界上做一次运行时收窄——反正模型返回的东西本来就需要校验。
 */
function asChoice(value: unknown): ChoiceLike | null {
  const a = value as Partial<ChoiceLike> | undefined;
  if (!a || typeof a.choice !== "string") return null;
  return {
    choice: a.choice,
    confidence: typeof a.confidence === "number" ? a.confidence : 0,
    probabilities: a.probabilities ?? {},
  };
}

function asNoul(value: unknown, fallback: number): number {
  const a = value as { noul?: number } | undefined;
  return typeof a?.noul === "number" ? a.noul : fallback;
}

/**
 * @param expectedKeys 送去给模型选的选项集合——分布的键必须正好与它相等。
 * @param selected 模型实际选中的那个 choice，必须是分布里概率最大的键。
 */
function checkDistribution(
  name: string,
  p: Record<string, number>,
  violations: string[],
  expectedKeys: readonly string[],
  selected: string,
): void {
  const keys = Object.keys(p);
  if (keys.length === 0) return; // 没给分布不算违规，只是少了留痕
  const sum = keys.reduce((s, k) => s + p[k], 0);
  if (Math.abs(sum - 1) > PROB_SUM_TOLERANCE) {
    violations.push(`${name} 的概率和为 ${sum.toFixed(3)}，不是一个分布`);
  }
  for (const k of keys) {
    if (p[k] < 0 || p[k] > 1) violations.push(`${name} 的 ${k} 概率 ${p[k]} 越界`);
  }
  // 键必须与选项集合正好一致：多出的键是模型在编造选项之外的东西，
  // 少了的键说明分布不完整——包含关系不够，必须是同一个集合
  const got = new Set(keys);
  const expected = new Set(expectedKeys);
  const extra = keys.filter((k) => !expected.has(k));
  const missing = expectedKeys.filter((k) => !got.has(k));
  if (extra.length > 0 || missing.length > 0) {
    const parts = [];
    if (extra.length > 0) parts.push(`多出 ${JSON.stringify(extra)}`);
    if (missing.length > 0) parts.push(`缺少 ${JSON.stringify(missing)}`);
    violations.push(`${name} 的概率分布键与选项集合不符：${parts.join("，")}`);
  }
  // 被选中项必须是概率最大的那个：choice 与 probabilities 互相矛盾，
  // 说明这两个字段至少有一个是编的，整条答案不可信
  const maxProb = Math.max(...keys.map((k) => p[k]));
  if (!(selected in p) || p[selected] < maxProb) {
    violations.push(`${name} 选中的 ${JSON.stringify(selected)} 不是概率最大的选项`);
  }
}

function richState(input: JudgeInput) {
  const s = input.snapshot;
  // 产物必须进决策上下文，不能只进 body head 的选项：实测第二步模型会重复提议
  // 开标签页，因为它压根不知道链接已经拿到手了。选 action 的那一问看不见的东西，
  // 对这一问就等于不存在
  const gathered = input.bodySources.filter((b) => b.key !== "span").map((b) => b.hint);
  return {
    用户说: input.utterance,
    已经做完的步骤: input.history.length > 0 ? [...input.history] : ["还没有开始"],
    已经拿到的东西: gathered.length > 0 ? gathered : ["还没有拿到任何东西"],
    当前应用: s.front,
    当前窗口: s.window ?? "无窗口",
    正在运行的应用: s.running,
    选中的文字: s.selection ?? "无",
    可用的原话片段: [...input.spans],
  };
}

export async function judge(
  client: TypeSafeClient,
  input: JudgeInput,
  signal?: AbortSignal,
): Promise<Decision> {
  const t0 = Date.now();
  const violations: string[] = [];

  const actionOpts: Record<string, string | null> = {};
  for (const o of input.offers) actionOpts[o.id] = o.summary;

  // 动态 head：候选只有一个时代码直接填，少问一个问题就少一条失败路径
  const askSpan = input.spans.length >= 2;
  const askBody = input.bodySources.length >= 2;

  const questions: Record<string, unknown> = {
    action: choice("为了完成用户的要求，下一步应该做什么？", actionOpts),
    complete: noul("用户这句话已经把要做的事说完整了吗？还在半句中途则为否。"),
    destructive: noul("执行下��步会不可逆地删除或覆盖用户已有的数据吗？"),
  };
  if (askSpan) {
    const spanOpts: Record<string, string | null> = {};
    for (const s of input.spans) spanOpts[s] = null;
    // 刻意不提供 none：走到这里说明确实需要一个片段，
    // "都不合适"该由 action 选 ASK 表达，而不是在这里憋出一个空值
    // 措辞要顶住「整句也是合法子串」这个引力：候选里最长的那条永远逐字校验通过，
    // 实测模型会把「搜一下 X，把链接存进备忘录」整句当成搜索词。
    // 切片器负责把边界穷举出来，这句话负责让模型挑对那一个
    questions.span = choice(
      "用户原话里，哪一段是下一步要处理的那个东西本身？只取它，不要带上后面还要做的别的事。",
      spanOpts,
    );
  }
  if (askBody) {
    const bodyOpts: Record<string, string | null> = {};
    for (const b of input.bodySources) bodyOpts[b.key] = b.hint;
    questions.body = choice("要写进备忘录的内容应该取自哪里？", bodyOpts);
  }

  const r = await callModel(
    (s) =>
      client.systemOne(
        { state: richState(input), questions: questions as never },
        { signal: s, timeout: MODEL_TIMEOUT_MS, retry: NO_SDK_RETRY },
      ),
    signal,
  );
  const latency_ms = Date.now() - t0;
  const answers = r.answers as Record<string, unknown>;

  const action = asChoice(answers.action);
  if (!action) {
    return {
      judgement: {
        action: "none", probabilities: {}, confidence: 0, complete: 0, destructive: 1,
        backend: "jev", latency_ms,
      },
      span: null, bodySource: null,
      violations: ["模型没有返回 action 答案"],
    };
  }
  checkDistribution("action", action.probabilities, violations, Object.keys(actionOpts), action.choice);

  // 逐字校验：模型必须挑我们给过的片段，而那些片段必须是原话里原封不动的一段。
  // 没有这道校验，"模型只 pick 不生成"就只是约定而非保证。
  let span: string | null = null;
  if (askSpan) {
    const picked = asChoice(answers.span);
    if (!picked) {
      violations.push("模型没有返回 span 答案");
    } else if (!input.spans.includes(picked.choice)) {
      violations.push(`模型返回了未提供的片段 ${JSON.stringify(picked.choice)}`);
    } else if (!isVerbatim(input.utterance, picked.choice)) {
      violations.push(`片段 ${JSON.stringify(picked.choice)} 不是用户原话的逐字子串`);
    } else {
      span = picked.choice;
      checkDistribution("span", picked.probabilities, violations, input.spans, picked.choice);
    }
  } else if (input.spans.length === 1) {
    span = input.spans[0];
  }

  let bodySource: string | null = null;
  if (askBody) {
    const picked = asChoice(answers.body);
    if (!picked) violations.push("模型没有返回 body 答案");
    else if (!input.bodySources.some((b) => b.key === picked.choice)) {
      violations.push(`模型返回了未提供的正文来源 ${JSON.stringify(picked.choice)}`);
    } else bodySource = picked.choice;
  } else if (input.bodySources.length === 1) {
    bodySource = input.bodySources[0].key;
  }

  return {
    judgement: {
      action: action.choice,
      probabilities: action.probabilities,
      confidence: action.confidence,
      complete: asNoul(answers.complete, 1),
      // 读不到就当最危险：缺失的安全信号不能默认成安全
      destructive: asNoul(answers.destructive, 1),
      backend: "jev",
      latency_ms,
    },
    span,
    bodySource,
    violations,
  };
}
