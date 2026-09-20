/**
 * 连通性探针：用真实感知快照 + 真实动作面跑一次完整决策，但不执行任何动作。
 *
 * 一次跑完验证四件事：凭证有效、中文指令可被理解、两级决策的概率分布是否可分、
 * 端到端真实延迟。最后一项是"不看屏幕"这条路线的核心证据，���进答辩材料。
 *
 * 它走的是 route → pick 两级决策，和 `bright-sight run` 的单 head 扁平决策是两条路：
 * 两级面向全量动作面（571+ 条，要先收窄到应用再挑命令），扁平面向白名单后的十来个选项。
 * 保留两级不是冗余——Phase 3 扩大白名单后动作面会重新超过 Choice 上限，那时要靠它。
 */
import { loadSurface } from "./actions.ts";
import { snapshotLight } from "./perceive.ts";
import { JevBackend } from "./decide.ts";
import { policy } from "./policy.ts";

export async function probeMain(utterance: string): Promise<void> {
  const t0 = Date.now();
  const snap = await snapshotLight();
  const tSnap = Date.now() - t0;

  const t1 = Date.now();
  const { actions, scriptable, fromCache } = await loadSurface();
  const tSurface = Date.now() - t1;

  const backend = new JevBackend();
  console.log(`指令: 「${utterance}」`);
  console.log(
    `感知 ${tSnap}ms | 动作面 ${tSurface}ms${fromCache ? "（缓存命中）" : "（冷启重建）"}` +
      ` (${actions.length} 个动作 / ${scriptable.length} 个应用)\n`,
  );

  // 候选优先给正在运行的应用，其余可脚本化应用补齐——用户说"记一下"时
  // 通常指的是已经开着的那个，而不是某个从未打开过的同类应用。
  const candidates = [...new Set([...snap.running.filter((a) => scriptable.includes(a)), ...scriptable])];

  const route = await backend.route({ utterance, snapshot: snap, candidates });
  console.log(`一级决策 → ${route.action}  (${route.latency_ms}ms)`);
  console.log(`  置信度 ${route.confidence.toFixed(3)} | 完整度 ${route.complete.toFixed(3)} | 破坏性 ${route.destructive.toFixed(3)}`);
  const top = Object.entries(route.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`  概率分布: ${top.map(([k, v]) => `${k} ${v.toFixed(3)}`).join(" | ")}`);

  if (route.action !== "none") {
    const appActions = actions.filter((a) => a.app === route.action);
    const pickJ = await backend.pick({ utterance, snapshot: snap, actions: appActions });
    const spec = appActions.find((a) => a.id === pickJ.action);
    console.log(`\n二级决策 → ${pickJ.action}  (${pickJ.latency_ms}ms)`);
    console.log(`  置信度 ${pickJ.confidence.toFixed(3)} | 静态风险 ${spec?.risk ?? "未知"}`);
    const top2 = Object.entries(pickJ.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 4);
    console.log(`  概率分布: ${top2.map(([k, v]) => `${k} ${v.toFixed(3)}`).join(" | ")}`);
    const g = policy({ judgement: pickJ, offered: [...appActions.map((a) => a.id), "none"], spec });
    console.log(`\n安全闸: ${g.kind} — ${g.reasons.join("；")}`);
  }
  console.log(`\n端到端 ${Date.now() - t0}ms`);
}
