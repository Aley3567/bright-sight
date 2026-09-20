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

  bright-sight profile [allow <目录名> | forget <目录名>]
        看当前在用的 Chrome profile 与允许名单；allow / forget 增删名单。
        AppleScript 里没有 profile 这个概念，能做的只有「看清楚会落在哪，陌生就问人」。

  环境变量:
    TYPESAFE_API_KEY     必需
    BRIGHTSIGHT_ENGINE   搜索引擎，默认 google
    BRIGHTSIGHT_JOURNAL  留痕脱敏。默认只落指纹；设为 full 才落原文（含原话、URL、标题）`;

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
  const { askYesNo, isInteractive, precheckProfile } = await import("./confirm.ts");
  const { makeRedactor, resolveRedactMode } = await import("./redact.ts");
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");

  const utterance = args.pos.join(" ").trim();
  if (!utterance) {
    console.error("要做什么？给一句话，例如：bright-sight run \"搜一下 TypeScript，把链接存进备忘录\"");
    return 2;
  }
  const dryRun = args.flags.execute !== true;
  const engine = resolveEngine(typeof args.flags.engine === "string" ? args.flags.engine : undefined);

  // profile 预检在执行之前：等到 policy 那道兜底闸才发现落在陌生 profile 上，
  // 用户已经白等了一次模型调用。dry-run 不发 Apple Event，所以只看不问，
  // 但仍然把探测结论打出来——这正是「加 --execute 之前需要先确认什么」的提前告知。
  const pre = await precheckProfile({ ask: !dryRun && isInteractive() ? askYesNo : null });
  if (pre.declined) {
    console.log("已取消，没有发出任何 Apple Event。");
    return 1;
  }
  const gate = dryRun ? ({ kind: "dry-run" } as const) : pre.gate;

  const mode = resolveRedactMode();
  const redactor = makeRedactor(mode, pre.settings.journalSalt);

  const offers = await loadOffers();
  const journal = await openJournal({
    // full 模式不传脱敏函数，于是每条事件的 redacted 字段如实为 false
    redact: mode === "hash" ? redactor.event : undefined,
  });
  const client = new TypeSafeClient();

  console.log(`指令: 「${utterance}」`);
  console.log(`模式: ${dryRun ? "dry-run（不发送任何 Apple Event）" : "真实执行"}`);
  console.log(`选项: ${offers.offers.length} 个（动作面共 ${offers.total} 条，白名单过滤后递给模型的就这些）`);
  console.log(`Chrome: ${pre.summary}${dryRun && pre.gate.kind !== "allowed" ? "（dry-run 不受此限，但 --execute 会）" : ""}`);
  console.log(`留痕: ${journal.path}${mode === "full" ? "（原文，未脱敏）" : "（已脱敏，只落指纹）"}\n`);

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
    { runId: journal.runId, profile: gate },
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
  // 判据是「不等于 true」而不是「等于 false」：脱敏这个字段是后加的，
  // 早于它的留痕里根本没有这一项。按 === false 判的话，那些**确实是原文**的旧记录
  // 会被静默当成安全的——把「不知道」算成「没问题」，正是这类提示最该避免的失败。
  const plain = events.filter((e) => e.redacted !== true).length;
  console.log(`\n${events.length} 条事件${broken > 0 ? `，另有 ${broken} 行读不出来` : ""}`);
  if (plain > 0) {
    console.log(`其中 ${plain} 条没有脱敏标记（含原话、URL、窗口标题），转发前先看清楚。`);
  }
  return 0;
}

/**
 * profile 子命令。
 *
 * 只打印目录名与「是否在名单内」这类结构信息；显示名只在 `list` 里出现一次，
 * 因为那正是人需要靠它认出「哪个是我的」的时刻。它不会被写进任何文件。
 */
async function cmdProfile(args: Args): Promise<number> {
  const { detectActiveProfile } = await import("./chrome.ts");
  const { isProfileAllowed, loadSettings, saveSettings, withProfileAllowed, withProfileForgotten, settingsPath } =
    await import("./settings.ts");

  const settings = await loadSettings();
  const [sub, target] = args.pos;

  if (sub === "allow" || sub === "forget") {
    if (!target) {
      console.error(`要哪个 profile？例如：bright-sight profile ${sub} Default`);
      return 2;
    }
    const next = sub === "allow" ? withProfileAllowed(settings, target) : withProfileForgotten(settings, target);
    await saveSettings(next);
    console.log(`${sub === "allow" ? "已加入" : "已移出"}允许名单: ${target}`);
    console.log(`名单: ${next.chrome.allowedProfiles.join(", ") || "（空）"}`);
    console.log(settingsPath());
    return 0;
  }
  if (sub) {
    console.error(`不认识的 profile 子命令: ${sub}（可用: allow / forget）`);
    return 2;
  }

  const d = await detectActiveProfile();
  console.log(`设置: ${settingsPath()}`);
  console.log(`允许名单: ${settings.chrome.allowedProfiles.join(", ") || "（空，任何 profile 都会先问一句）"}\n`);
  if (!d.ok) {
    console.log(`探测不到当前在用的 profile: ${d.reason}`);
    return 0;
  }
  console.log(`当前在用: ${d.active.dir}${d.active.name ? `（${d.active.name}）` : ""}`);
  console.log(`  Local State: ${d.byState ?? "无"}　Preferences mtime: ${d.byMtime ?? "无"}`);
  if (!d.agree) {
    // Local State 实测滞后 3–5 秒，刚切过 profile 时两路必然对不上
    console.log(`  两路探测不一致——Local State 的写入滞后于实际切换，过几秒再看一次。`);
  }
  console.log(`\n全部 profile:`);
  for (const pf of d.all) {
    const mark = isProfileAllowed(settings, pf.dir) ? "允许" : "待确认";
    console.log(`  [${mark}] ${pf.dir}${pf.name ? `　${pf.name}` : ""}`);
  }
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
    case "profile":
      return cmdProfile(args);
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
