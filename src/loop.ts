import { LIMITS } from "./config.ts";
import type { BodySource, Decision, JudgeInput } from "./decide.ts";
import { ARTIFACT_PREFIX, SPAN_SOURCE, resolveArgs, type ExecContext, type ExecOutcome } from "./execute.ts";
import { policy, type PolicyResult } from "./policy.ts";
import { REGISTRY } from "./scripts.ts";
import { extractSpans } from "./spans.ts";
import type { OfferSet } from "./surface.ts";
import { probeIdFor, type Probe, type VerifyInput } from "./verify.ts";
import { isTaskAction, type Artifact, type RunState, type Snapshot, type StepRecord, type VerifyResult } from "./types.ts";

/**
 * 四步闭环的编排：observe → judge → act → verify，反复直到收手。
 *
 * 循环存在的理由不是"模型不生成文本所以没法预先规划"——那个理由是从
 * 网页智能体那边继承来的，在静态的 sdef 上并不成立。真实理由有三条：
 * 后一步要用前一步的产物、某一步可能失败需要换条路、步数事先不定。
 *
 * 所有依赖都是函数参数。测试注入假 backend 和假 executor 就能把整个控制流
 * 跑完，不碰网络也不碰应用——这比 mock 框架直白，也不会在重构时悄悄失效。
 */

export type LoopDeps = {
  observe: () => Promise<Snapshot>;
  decide: (input: JudgeInput) => Promise<Decision>;
  act: (actionId: string, ctx: ExecContext, step: number) => Promise<ExecOutcome>;
  probe: (id: string, argv?: string[]) => Promise<Probe | null>;
  checkStep: (input: VerifyInput) => Promise<VerifyResult>;
  /** 留痕，失败不影响主流程。 */
  record?: (phase: "observe" | "judge" | "act" | "verify", step: number, data: unknown) => Promise<void>;
};

export type LoopOptions = {
  maxSteps?: number;
  runId?: string;
  /** 连续 WAIT 的容忍次数。超过说明模型在原地打转，不是真的在等。 */
  maxConsecutiveWaits?: number;
};

/** 产物值可能很长（网页标题、URL），给模型看摘要就够，完整值只在代码里流转。 */
function brief(v: string, n = 80): string {
  return v.length <= n ? v : `${v.slice(0, n)}…`;
}

/**
 * 构造"正文可以取自哪里"的候选。
 *
 * 产物值来自页面回读，是不可信数据。把它放进 state 给模型看是安全的：
 * 模型只回答选择题、只返回概率分布，它的输出还要过白名单和逐字校验才可能变成动作。
 * 不安全的是把它拼进脚本文本——那条路在 osa.ts 里根本不存在。
 */
function bodySourcesFrom(artifacts: readonly Artifact[], span: string | null): BodySource[] {
  const out: BodySource[] = artifacts.map((a) => ({
    key: `${ARTIFACT_PREFIX}${a.key}`,
    hint: `第 ${a.from.step} 步得到的 ${a.key}：${brief(a.value)}`,
  }));
  if (span) out.push({ key: SPAN_SOURCE, hint: `用户原话里的片段：${brief(span)}` });
  return out;
}

/** 重复守卫的键：同一个动作配同一组解析结果，第二次提议就说明在原地打转。 */
function guardKey(actionId: string, ctx: ExecContext): string {
  const t = REGISTRY[actionId];
  if (!t) return `${actionId}|<无模板>`;
  const r = resolveArgs(t, ctx);
  return `${actionId}|${r.ok ? JSON.stringify(r.argv) : "<解析失败>"}`;
}

function summarize(rec: StepRecord): string {
  const v = rec.verify ? (rec.verify.ok ? "验证通过" : "验证未过") : "未验证";
  return `第 ${rec.step} 步：${rec.actionId} — ${v}`;
}

export async function runLoop(
  utterance: string,
  offerSet: OfferSet,
  deps: LoopDeps,
  opts: LoopOptions = {},
): Promise<RunState> {
  const maxSteps = opts.maxSteps ?? LIMITS.maxSteps;
  const maxWaits = opts.maxConsecutiveWaits ?? 2;
  const state: RunState = { runId: opts.runId ?? "", utterance, status: "running", steps: [], artifacts: [] };

  const proposed = new Set<string>();
  let waits = 0;

  for (let step = 1; step <= maxSteps; step++) {
    const snapshot = await deps.observe();
    await deps.record?.("observe", step, { front: snapshot.front, window: snapshot.window });

    const spans = extractSpans(utterance);
    // 先用最可能的片段构造正文候选；模型改选了别的片段，下一轮自然会跟着变
    const bodySources = bodySourcesFrom(state.artifacts, spans[0] ?? null);

    const decision = await deps.decide({
      utterance,
      snapshot,
      offers: offerSet.offers,
      spans,
      bodySources,
      history: state.steps.map(summarize),
    });
    await deps.record?.("judge", step, decision);

    // 决策消费一次：判断已经产生，后面无论走哪条分支都不会再用这一份
    const j = decision.judgement;

    let p: PolicyResult;
    if (decision.violations.length > 0) {
      // 答案校验没过就整条作废，绝不 act。模型返回了我们没给过的东西，
      // 说明这次交互本身不可信，挑出"看起来还行的那部分"继续用是错的
      p = { kind: "ignore", actionId: null, reasons: decision.violations };
    } else {
      p = policy({
        judgement: j,
        offered: offerSet.ids,
        spec: offerSet.specs.get(j.action),
        template: REGISTRY[j.action],
      });
    }

    const rec: StepRecord = {
      step,
      observe: snapshot,
      judgement: j,
      actionId: p.actionId ?? j.action,
      exec: null,
      verify: null,
      reasons: p.reasons,
    };

    if (p.kind === "wait") {
      waits++;
      state.steps.push(rec);
      if (waits > maxWaits) {
        rec.reasons.push(`连续 ${waits} 次 WAIT，判定为原地打转`);
        state.status = "blocked";
        return state;
      }
      continue;
    }
    waits = 0;

    if (p.kind === "ask" || p.kind === "confirm") {
      state.steps.push(rec);
      state.status = "needs_input";
      return state;
    }

    if (p.kind === "ignore") {
      state.steps.push(rec);
      // 终止不信任 DONE：模型说完成了，还得每一步都验证通过才算数
      if (j.action === "DONE") {
        const executed = state.steps.filter((s) => s.exec !== null);
        const allGreen = executed.length > 0 && executed.every((s) => s.verify?.ok === true);
        if (allGreen) {
          state.status = "done";
        } else {
          state.status = "blocked";
          rec.reasons.push(
            executed.length === 0
              ? "模型声称完成，但一个动作都没有执行过"
              : "模型声称完成，但有步骤的验证没通过",
          );
        }
        return state;
      }
      state.status = "blocked";
      return state;
    }

    // ── p.kind === "execute" ──
    const actionId = p.actionId!;
    const ctx: ExecContext = {
      span: decision.span,
      bodySource: decision.bodySource,
      artifacts: state.artifacts,
    };

    const key = guardKey(actionId, ctx);
    if (proposed.has(key)) {
      rec.reasons.push(`同一个动作配同一组参数被第二次提议：${key}`);
      state.steps.push(rec);
      state.status = "blocked";
      return state;
    }
    proposed.add(key);

    const probeId = probeIdFor(actionId);
    const pre = probeId ? await deps.probe(probeId) : null;

    const outcome = await deps.act(actionId, ctx, step);
    rec.exec = outcome.result;
    // 执行后先记录再观察：万一取快照或验证炸了，这次真实发生过的动作也不能从账上消失
    state.steps.push(rec);
    await deps.record?.("act", step, outcome.result);
    state.artifacts.push(...outcome.artifacts);

    // 观察与验证都可能抛：探针是另一次 Apple Event，应用随时可能没响应。
    // 但动作已经真实发生了，异常不能把它连同整条 state 一起带走——
    // 「执行后先记录再观察」只有在这里兜住异常时才真的成立
    try {
      const post = probeId ? await deps.probe(probeId) : null;
      rec.verify = await deps.checkStep({
        actionId,
        exec: outcome.result,
        rawArgv: outcome.rawArgv,
        pre,
        post,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      rec.verify = { ok: false, checks: [{ name: "verify_crashed", ok: false, detail }] };
    }
    await deps.record?.("verify", step, rec.verify);

    if (!rec.verify.ok) {
      state.status = "blocked";
      return state;
    }
  }

  // 走完 maxSteps 还没收手。步数上限按"最坏情况用户能接受几次误操作"定，不是按 token
  state.status = "blocked";
  return state;
}

export { isTaskAction };
