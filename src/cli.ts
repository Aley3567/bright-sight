// bright-sight <command>：run | surface | probe | journal
import { readdir } from "node:fs/promises";
import { LIMITS, resolveEngine } from "./config.ts";

const USAGE = `bright-sight — 不看屏幕的 macOS 桌面智能体

  bright-sight run "<一句话>" [--execute] [--engine <名字>]
        走完 observe → judge → act → verify 的闭环。
        默认 dry-run：只打印每一步解析出的完整 argv，不投递任何 Apple Event。
        --execute 才真发。注意 dry-run 只能演练到第一步——第二步的参数依赖
        第一步的真实回读（浏览器最终停在哪个地址），不执行就拿不到。

  bright-sight surface [--all] [--rebuild]
        看动作面：从 sdef 自动长出来的全部命令，以及白名单过滤后真正递给模型的选项。

  bright-sight probe ["<一句话>"]
        只决策不执行的连通性探针，走 route → pick 两级，面向全量动作面。

  bright-sight journal [<文件>]
        不带参数列出历史 run；带文件名回放那一次的四步事件。

  环境变量: TYPESAFE_API_KEY（必需）、BRIGHTSIGHT_ENGINE（搜索引擎，默认 google）`;

type Args = { cmd: string; pos: string[]; flags: Record<string, string | true> };

function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { cmd, pos, flags };
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function cmdRun(args: Args): Promise<number> {
  // 重子命令懒加载：surface / journal 不该为了跑起来先把 SDK 和执行器都拖进内存
  const { loadOffers } = await import("./surface.ts");
  const { runLoop } = await import("./loop.ts");
  const { judge } = await import("./decide.ts");
  const { execute } = await import("./execute.ts");
  const { runProbe, verify } = await import("./verify.ts");
  const { openJournal } = await import("./journal.ts");
  const { snapshotLight } = await import("./perceive.ts");
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");

  const utterance = args.pos.join(" ").trim();
  if (!utterance) {
    console.error("要做什么？给一句话，例如：bright-sight run \"搜一下 TypeScript，把链接存进备忘录\"");
    return 2;
  }
  const dryRun = args.flags.execute !== true;
  const engine = resolveEngine(typeof args.flags.engine === "string" ? args.flags.engine : undefined);

  const offers = await loadOffers();
  const journal = await openJournal();
  const client = new TypeSafeClient();

  console.log(`指令: 「${utterance}」`);
  console.log(`模式: ${dryRun ? "dry-run（不发送任何 Apple Event）" : "真实执行"}`);
  console.log(`选项: ${offers.offers.length} 个（动作面共 ${offers.total} 条，白名单过滤后递给模型的就这些）`);
  console.log(`留痕: ${journal.path}\n`);

  const state = await runLoop(
    utterance,
    offers,
    {
      observe: snapshotLight,
      decide: (input) => judge(client, input),
      act: (id, ctx, step) => execute(id, { ...ctx, engine }, step, { dryRun }),
      // dry-run 不取快照：probe 本身无副作用，但让 pre/post 停在 null 才如实反映
      // "这一轮什么都没发生"，而不是拿真实计数去凑一份看起来成立的 diff
      probe: (id, argv) => (dryRun ? Promise.resolve(null) : runProbe(id, argv)),
      checkStep: (input) =>
        dryRun
          ? Promise.resolve({ ok: true, checks: [{ name: "dry_run", ok: true, detail: "未执行，跳过验证" }] })
          : verify({ ...input, engine }),
      record: (phase, step, data) => journal.append(phase, step, data),
    },
    { runId: journal.runId },
  );

  for (const s of state.steps) {
    const j = s.judgement;
    console.log(`── 第 ${s.step} 步 ──`);
    console.log(`  判断: ${s.actionId}  置信 ${j.confidence.toFixed(3)} | 完整 ${j.complete.toFixed(3)} | 破坏 ${j.destructive.toFixed(3)}`);
    if (s.reasons.length) console.log(`  策略: ${s.reasons.join("；")}`);
    if (s.exec) {
      console.log(`  参数: ${JSON.stringify(s.exec.argv)}`);
      console.log(s.exec.ok ? `  执行: 成功 ${fmtMs(s.exec.ms)}` : `  执行: 失败 — ${s.exec.errors.join("；")}`);
      if (s.exec.ok && Object.keys(s.exec.readback).length) {
        console.log(`  回读: ${Object.entries(s.exec.readback).map(([k, v]) => `${k}=${v}`).join(" | ")}`);
      }
    }
    for (const c of s.verify?.checks ?? []) console.log(`  ${c.ok ? "通过" : "未过"} ${c.name}: ${c.detail}`);
  }

  if (state.artifacts.length) {
    console.log(`\n产物:`);
    for (const a of state.artifacts) console.log(`  ${a.key} = ${a.value}  ← 第 ${a.from.step} 步 ${a.from.field}`);
  }

  const failures = journal.failures();
  if (failures > 0) console.log(`\n留痕有 ${failures} 条没写进去（不影响已经发生的操作，但这次记录不完整）`);
  console.log(`\n结果: ${state.status}`);
  if (dryRun && state.status !== "done") {
    console.log(`dry-run 到此为止是正常的：后续步骤要用前一步真实回读到的值，加 --execute 才能往下走。`);
  }
  return state.status === "done" || dryRun ? 0 : 1;
}

async function cmdSurface(args: Args): Promise<number> {
  const { buildSurface, loadSurface } = await import("./actions.ts");
  const { offersFrom } = await import("./surface.ts");

  const t0 = Date.now();
  // --rebuild 绕过缓存而不是污染它：装了新应用但 mtime 没动时，这是唯一的自救手段
  const surface = args.flags.rebuild === true
    ? { ...(await buildSurface()), fromCache: false }
    : await loadSurface();
  const ms = Date.now() - t0;
  console.log(`动作面: ${surface.actions.length} 条 / ${surface.scriptable.length} 个可脚本化应用 / 共扫 ${surface.apps.length} 个应用`);
  console.log(`耗时 ${fmtMs(ms)}${surface.fromCache ? "（缓存命中）" : "（冷启重建）"}\n`);

  const offers = offersFrom(surface);
  console.log(`白名单过滤后递给模型的选项（${offers.offers.length} 个）:`);
  for (const o of offers.offers) console.log(`  ${o.id}\n    ${o.summary}`);

  if (args.flags.all === true) {
    console.log(`\n全部 ${surface.actions.length} 条动作:`);
    for (const a of surface.actions) console.log(`  [${a.risk}] ${a.id}`);
  } else {
    console.log(`\n（--all 看全部 ${surface.actions.length} 条）`);
  }
  return 0;
}

async function cmdJournal(args: Args): Promise<number> {
  const { journalDir, readJournal } = await import("./journal.ts");
  const dir = journalDir();
  const file = args.pos[0];

  if (!file) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort().reverse();
    } catch {
      console.log(`还没有任何记录（${dir} 不存在）`);
      return 0;
    }
    if (names.length === 0) {
      console.log(`还没有任何记录（${dir} 是空的）`);
      return 0;
    }
    console.log(`${dir}\n`);
    for (const n of names.slice(0, 20)) console.log(`  ${n}`);
    if (names.length > 20) console.log(`  …还有 ${names.length - 20} 条`);
    console.log(`\n回放: bright-sight journal ${names[0]}`);
    return 0;
  }

  const path = file.includes("/") ? file : `${dir}/${file}`;
  const { events, broken } = await readJournal(path);
  for (const e of events) {
    const head = `${e.at}  第 ${e.step} 步  ${e.phase}`;
    console.log(`${head}\n  ${JSON.stringify(e.data)}`);
  }
  console.log(`\n${events.length} 条事件${broken > 0 ? `，另有 ${broken} 行读不出来` : ""}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  switch (args.cmd) {
    case "run":
      return cmdRun(args);
    case "surface":
      return cmdSurface(args);
    case "probe": {
      const { probeMain } = await import("./probe.ts");
      await probeMain(args.pos.join(" ").trim() || "打开备忘录记一下今天的会议要点");
      return 0;
    }
    case "journal":
      return cmdJournal(args);
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`不认识的命令: ${args.cmd}\n`);
      console.error(USAGE);
      return 2;
  }
}

export { LIMITS };
