import { resolveEngine, type SearchEngine } from "./config.ts";
import { osa, parseReadback } from "./osa.ts";
import { PROBES, type ScriptTemplate } from "./scripts.ts";
import type { ExecResult, VerifyCheck, VerifyResult } from "./types.ts";

/**
 * 验证层：执行完到底有没有真的发生。
 *
 * 全部判据由代码给出，模型不参与自证结果——让模型判断自己刚才做成没有，
 * 等于把"做成了"这件事的定义权交给了可能出错的那一方。
 *
 * 两类证据：脚本自己的返回值（做了什么），以及执行前后各取一次的只读快照差分
 * （世界变了没有）。只有返回值会骗人（脚本返回成功但对象没落地），
 * 只有 diff 会误判（别的程序同时也在改）。两者都要。
 */

export type Probe = Record<string, string>;

/** 跑一条只读探针。探针不在 REGISTRY 里，模型永远选不到它们。 */
export async function runProbe(id: string, argv: string[] = []): Promise<Probe | null> {
  const t: ScriptTemplate | undefined = PROBES[id];
  if (!t) return null;
  const r = await osa(t.src, argv, { timeoutMs: t.timeoutMs });
  if (!r.ok) return null;
  const rb = parseReadback(r.raw, t.fields);
  return rb.ok ? rb.values : null;
}

/** 每个动作执行前后要取哪条快照。 */
export function probeIdFor(actionId: string): string | null {
  if (actionId === "Google Chrome.make-tab") return "probe.chrome-counts";
  if (actionId === "Notes.make-note") return "probe.notes-count";
  return null;
}

/**
 * 定向回读的执行器，可注入。
 *
 * 默认就是真发 Apple Event 的 `runProbe`。之所以做成参数，是为了让 verify 的判据逻辑
 * 能被单元测试完整覆盖——在此之前，测试只能靠「故意不给 id」来绕开真实调用，
 * 于是「回读到了但内容不对」这条最该测的路径反而测不到。
 */
export type ProbeRunner = (id: string, argv?: string[]) => Promise<Probe | null>;

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function check(name: string, ok: boolean, detail: string): VerifyCheck {
  return { name, ok, detail };
}

/**
 * origin 比较而不是全等比较。
 *
 * 实测 Google 会把 `?q=erasableSyntaxOnly` 重写成 `?q=erasableSyntaxOnly&sei=...`，
 * 全等断言注定失败。而 resultOrigins 这一层也是实测逼出来的：
 * Bing 会把 www.bing.com 跳到 cn.bing.com，百度直接跳到反爬验证码页——
 * 后者恰恰说明这条判据有真实价值，它是唯一能抓住"加载完了但落在了错误站点"的检查。
 */
function originOk(sent: string, got: string, engine: SearchEngine): { ok: boolean; detail: string } {
  let a: string;
  let b: string;
  try {
    a = new URL(sent).origin;
    b = new URL(got).origin;
  } catch {
    return { ok: false, detail: `地址无法解析：发出 ${sent}，回读 ${got}` };
  }
  if (a === b) return { ok: true, detail: `origin 一致 ${b}` };
  if (engine.resultOrigins.includes(b)) return { ok: true, detail: `origin 变为 ${b}，在该引擎的允许清单内` };
  return { ok: false, detail: `origin 从 ${a} 变成了 ${b}，不在允许清单内` };
}

export type VerifyInput = {
  actionId: string;
  exec: ExecResult;
  /** HTML 转义之前的 argv，用于和回读的 plaintext 做包含判断。 */
  rawArgv: readonly string[];
  pre: Probe | null;
  post: Probe | null;
  engine?: SearchEngine;
  /** 定向回读怎么执行。默认真发 Apple Event。 */
  probe?: ProbeRunner;
};

export async function verify(input: VerifyInput): Promise<VerifyResult> {
  const { actionId, exec, rawArgv, pre, post } = input;
  const engine = input.engine ?? resolveEngine();
  const probe = input.probe ?? runProbe;
  const checks: VerifyCheck[] = [];

  // exit_ok 覆盖三件事：进程退出码、回读前缀、字段数——它们都在 osa.parseReadback 里判过，
  // 这里只是把结论纳入同一张检查表，让"全绿才算成功"这句话没有例外
  checks.push(
    exec.ok
      ? check("exit_ok", true, `回读到 ${Object.keys(exec.readback).length} 个字段`)
      : check("exit_ok", false, exec.errors.join("；")),
  );
  if (!exec.ok) return { ok: false, checks };

  if (actionId === "Google Chrome.make-tab") {
    const preW = num(pre?.windows);
    const preT = num(pre?.tabs);
    const postW = num(post?.windows ?? exec.readback.windows);
    const postT = num(post?.tabs ?? exec.readback.tabs);
    // 两条择一：多了一个标签页，或者从"进程在跑但零窗口"变成了有窗口。
    // 后半句不是防御性编程，是实测状态：Chrome 在运行、count of windows 返回 0
    const grew = postT > preT;
    const woke = preW === 0 && postW >= 1;
    checks.push(check("tab_appeared", grew || woke,
      `标签页 ${preT} → ${postT}，窗口 ${preW} → ${postW}`));

    // 按 id 把刚开的那个标签页重新找出来，而不是去看「最前面那个」。
    // `window 1` 是叠放顺序，profile 一换就可能指向别人的窗口——这是
    // 同名 Notes 文件夹、同名笔记之后，同一类缺陷的第三次出现。
    const tabId = exec.readback.tab_id ?? "";
    let got = exec.readback.url ?? "";
    if (!tabId) {
      checks.push(check("tab_id_readback", false, "脚本没有回读到 tab id，无法定向复查"));
    } else {
      const rb = await probe("probe.chrome-tab", [tabId]);
      if (!rb) {
        checks.push(check("tab_id_readback", false, `按 id ${tabId} 定向回读失败`));
      } else if (rb.found !== "yes") {
        checks.push(check("tab_id_readback", false, `按 id ${tabId} 找不到这个标签页，它可能已经被关掉了`));
      } else {
        checks.push(check("tab_id_readback", true, `按 id ${tabId} 找回了这个标签页`));
        // 定向回读比脚本返回值晚发生，跳转可能在这之间才完成——以更新的那份为准
        if (rb.url) got = rb.url;
      }
    }

    const sent = rawArgv[0] ?? "";
    const o = originOk(sent, got, engine);
    checks.push(check("url_origin_match", o.ok, o.detail));
  }

  if (actionId === "Notes.make-note") {
    const preN = num(pre?.count);
    const postN = num(post?.count ?? exec.readback.count);
    checks.push(check("note_delta", postN - preN === 1, `笔记数 ${preN} → ${postN}`));

    // 不是相信我们写对了容器，是回读它实际落在了哪——本机有两个同名 Notes 文件夹
    const folder = exec.readback.folder ?? "";
    const account = exec.readback.account ?? "";
    checks.push(check("container_match", folder !== "" && account !== "",
      `落在 ${account} / ${folder}`));

    const id = exec.readback.id ?? "";
    const needle = rawArgv[1] ?? "";
    if (!id || !needle) {
      checks.push(check("body_contains_payload", false, "缺少笔记 id 或待查内容，无法定向回读"));
    } else {
      // 按 id 不按 name：同名笔记的问题和同名 folder 一样真实存在
      const rb = await probe("probe.notes-note", [id, needle]);
      if (!rb) checks.push(check("body_contains_payload", false, "定向回读失败"));
      else {
        checks.push(check("body_contains_payload", rb.contains === "yes",
          `正文 ${rb.len} 字，包含目标内容：${rb.contains}`));
        checks.push(check("container_readback", rb.folder === folder && rb.account === account,
          `回读容器 ${rb.account} / ${rb.folder}`));
      }
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
