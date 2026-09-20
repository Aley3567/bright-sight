import test from "node:test";
import assert from "node:assert/strict";
import {
  PERCEIVE_SCRIPTS,
  axErrorNumber,
  axFailureOfText,
  axFaultOfCode,
  elementsViewOf,
  windowTitleOf,
  windowViewOf,
} from "../src/perceive.ts";
import { OSA_TIMEOUT, RS } from "../src/osa.ts";

/**
 * 感知层的权限失败分类。
 *
 * 这一档全部是纯函数测试，零 IO：缺权限的那条路在一台**已经授权**的机器上根本跑不出来，
 * 所以把「解析 osascript 错误并分类」抽成不依赖外部世界的函数，再喂给它错误样本。
 *
 * ── 样本的来源，逐条注明 ──
 * - `-1743` / `-1719` 的中文错误行：**本机实测**。用 `osascript -e 'error number -1743'`
 *   让 osascript 自己把错误格式化到 stderr，抄的是它真实的输出格式与本地化消息。
 *   （这是真实的**格式**样本，不是真实的 TCC 拒绝现场——本机已授予辅助功能权限，
 *   拒绝现场无法复现。）
 * - `none` 回读：**本机实测**，对 Dock 这个零窗口进程真跑窗口脚本得到。
 * - 英文错误行、`fault` 回读：**构造的**。英文那条用来证明判据是错误号而不是文本，
 *   `fault` 回读用来覆盖 `on error` 分支——那条分支在本机跑不出来。
 */

/** 本机实测：`osascript -e 'error number -1743'` 的 stderr 首行。 */
const REAL_1743 = "0:18: execution error: 未获得授权将Apple事件发送给current application。 (-1743)";
/** 本机实测：`osascript -e 'error number -1719'` 的 stderr 首行。 */
const REAL_1719 = "0:18: execution error: 不能获得“«script»”。无效的索引。 (-1719)";
/** 构造：英文环境下 System Events 拒绝辅助访问时的典型一行。 */
const FAKE_EN_1719 = "execution error: System Events got an error: osascript is not allowed assistive access. (-1719)";
/** 本机实测：对零窗口进程（Dock）跑窗口脚本得到的回读。 */
const REAL_NONE = `RB1${RS}none${RS}${RS}${RS}${RS}`;

/** 构造一条窗口/元素脚本形状的回读。字段顺序与 src/perceive.ts 的 AX_FIELDS 一致。 */
function readback(state: string, payload = "", code = "", stage = "", message = ""): string {
  return ["RB1", state, payload, code, stage, message].join(RS);
}

/* ── 错误号分类 ─────────────────────────────────────────────────────────── */

test("perceive: -1743 一律读作缺自动化授权，与失败发生在哪一步无关", () => {
  for (const stage of ["reach", "name", "contents", "随便什么"]) {
    assert.equal(axFaultOfCode(-1743, stage), "automation", `stage=${stage}`);
  }
});

test("perceive: -25211（kAXErrorAPIDisabled）一律读作缺辅助功能授权", () => {
  for (const stage of ["reach", "name", "contents"]) {
    assert.equal(axFaultOfCode(-25211, stage), "accessibility", `stage=${stage}`);
  }
});

test("perceive: -1719 的两种含义靠阶段区分——拦得住，也不越界", () => {
  // 同一个错误号，新旧两条分支同时可能命中：它既是 System Events 报告「不允许辅助访问」
  // 时用的号，又是通用的「无效的索引」。第一次触碰无障碍 API 就失败才可能是权限问题；
  // 我们自己数过窗口数大于 0 之后再取标题还失败，那只能是索引问题。
  assert.equal(axFaultOfCode(-1719, "reach"), "accessibility");
  assert.equal(axFaultOfCode(-1719, "contents"), "accessibility");
  assert.equal(axFaultOfCode(-1719, "name"), "unknown");
  // 阶段名写错（比如将来改了脚本忘了同步）不能悄悄升格成权限问题
  assert.equal(axFaultOfCode(-1719, ""), "unknown");
});

test("perceive: 认不出的错误号一律 unknown，绝不退回「没有窗口」", () => {
  // fail-closed 的核心：这个函数的返回类型里压根没有「没有窗口」这个选项，
  // 但兜底值选 unknown 而不是某个具体权限，免得把用户指去错误的系统设置面板
  for (const code of [-1728, -600, -1712, 0, 1]) {
    assert.equal(axFaultOfCode(code, "reach"), "unknown", `code=${code}`);
  }
});

/* ── 错误文本分类 ───────────────────────────────────────────────────────── */

test("perceive: 从实测的错误行里抠得出错误号", () => {
  assert.equal(axErrorNumber(REAL_1743), -1743);
  assert.equal(axErrorNumber(REAL_1719), -1719);
  assert.equal(axErrorNumber(FAKE_EN_1719), -1719);
});

test("perceive: 抠不到错误号就是抠不到，不瞎给一个", () => {
  // 阳性对照配在上一条：那三行都抠得到，所以这里的 null 不是正则整个失效
  assert.equal(axErrorNumber(""), null);
  assert.equal(axErrorNumber("execution error: 什么都没有"), null);
  // 正数不是 AppleScript 错误号的写法，不认
  assert.equal(axErrorNumber("(1743)"), null);
});

test("perceive: 判据是错误号，不是错误文本——换语言环境结论不变", () => {
  // 本机 osascript 的错误消息跟着系统语言走（实测中文），拿文本当判据
  // 换一台英文机器就全部落空。这两条内容完全不同、号相同，结论必须相同。
  assert.equal(axFailureOfText(REAL_1719).fault, axFailureOfText(FAKE_EN_1719).fault);
  assert.equal(axFailureOfText(REAL_1719).fault, "accessibility");
  assert.equal(axFailureOfText(REAL_1743).fault, "automation");
});

test("perceive: 超时是超时，不是权限问题", () => {
  assert.equal(axFailureOfText(OSA_TIMEOUT).fault, "timeout");
  // 超时的 detail 里不该出现「授权」这种会把人指去系统设置的措辞
  assert.ok(!axFailureOfText(OSA_TIMEOUT).detail.includes("授权"));
});

test("perceive: 认出来的故障不带原始消息，认不出来的才带", () => {
  // 隐私判据：AppleScript 的消息可能夹带应用名或窗口标题。认出来了就没必要带，
  // 认不出来时它是唯一线索，值得带且截断。
  const known = axFailureOfText(REAL_1743);
  assert.ok(!known.detail.includes("未获得授权将Apple事件发送给"));
  assert.match(known.detail, /-1743/);

  const weird = axFailureOfText("execution error: 谁知道发生了什么");
  assert.ok(weird.detail.includes("谁知道发生了什么"));
});

/* ── 窗口三态 ───────────────────────────────────────────────────────────── */

test("perceive: 读到窗口就是读到窗口", () => {
  assert.deepEqual(windowViewOf(readback("window", "无标题 — 文本编辑")), {
    kind: "window",
    title: "无标题 — 文本编辑",
  });
});

test("perceive: 零窗口进程回读的是 none（实测样本）", () => {
  assert.deepEqual(windowViewOf(REAL_NONE), { kind: "none" });
});

test("perceive: 缺辅助功能授权落在 unavailable，不是 none", () => {
  // 这条就是本次改动要修的东西：改之前两者都是 window: null
  const v = windowViewOf(readback("fault", "", "-1719", "reach", "not allowed assistive access"));
  assert.equal(v.kind, "unavailable");
  assert.equal(v.kind === "unavailable" && v.fault, "accessibility");
});

test("perceive: 同一个错误号在后一步失败时不冒充权限问题", () => {
  // 与上一条成对：判据装在了正确的位置，才会这一条 accessibility、那一条 unknown
  const v = windowViewOf(readback("fault", "", "-1719", "name", "invalid index"));
  assert.equal(v.kind === "unavailable" && v.fault, "unknown");
});

test("perceive: 回读损坏一律 unavailable，永远不许兜底成 none", () => {
  // none 是一个结论（脚本明确回答了窗口数为 0），不能由「没看懂」得出。
  // 这四种损坏形状改之前都会变成 window: null，和真的没有窗口分不开。
  const broken = [
    "", // 空
    "窗口标题", // 根本不是回读
    `RB2${RS}none${RS}${RS}${RS}${RS}`, // 前缀版本不对
    `RB1${RS}none${RS}`, // 字段数不够
    readback("none", "", "", "", "") + RS + "多了一个字段",
  ];
  for (const raw of broken) {
    const v = windowViewOf(raw);
    assert.equal(v.kind, "unavailable", `${JSON.stringify(raw)} 应当判为看不到`);
    assert.equal(v.kind === "unavailable" && v.fault, "unknown");
  }
});

test("perceive: 没见过的状态词不许滑进任何一个成功态", () => {
  for (const state of ["ok", "null", "", "NONE"]) {
    const v = windowViewOf(readback(state, "标题"));
    assert.equal(v.kind, "unavailable", `state=${JSON.stringify(state)}`);
  }
});

test("perceive: fault 但错误号不是数字，也只能是 unknown", () => {
  const v = windowViewOf(readback("fault", "", "不是数字", "reach", ""));
  assert.equal(v.kind === "unavailable" && v.fault, "unknown");
});

test("perceive: 标题恰好叫 none 的窗口仍然是一个窗口", () => {
  // 状态词和标题分属不同字段，判据不该跑到标题上去
  assert.deepEqual(windowViewOf(readback("window", "none")), { kind: "window", title: "none" });
});

test("perceive: 标题里的制表符、换行和引号原样保留", () => {
  // 回读按 ASCII 记录分隔符切，正文里这些字符不是分隔符——这正是不拼 JSON 的理由
  const title = 'a\tb\nc "d" \\e';
  assert.deepEqual(windowViewOf(readback("window", title)), { kind: "window", title });
});

/* ── 扁平字段与三态的关系 ───────────────────────────────────────────────── */

test("perceive: 扁平的 window 字段分不开的那两种情况，windowView 分得开", () => {
  // 旧行为原样保留：没有窗口和看不到窗口，扁平字段都是 null。
  // 新增的信息全在 windowView 里——这条测试就是在钉住「新旧两条通道各自该说什么」。
  const none = windowViewOf(REAL_NONE);
  const denied = windowViewOf(readback("fault", "", "-25211", "reach", ""));
  assert.equal(windowTitleOf(none), null);
  assert.equal(windowTitleOf(denied), null);
  assert.notDeepEqual(none, denied);

  // 有窗口但没标题：扁平字段仍是 null（旧行为），但它既不是 none 也不是 unavailable
  const untitled = windowViewOf(readback("window", ""));
  assert.equal(windowTitleOf(untitled), null);
  assert.equal(untitled.kind, "window");

  assert.equal(windowTitleOf(windowViewOf(readback("window", "zsh"))), "zsh");
});

/* ── 元素两态 ───────────────────────────────────────────────────────────── */

test("perceive: 元素回读按角色白名单过滤，missing value 不当标签", () => {
  const payload = [
    "button\t确定",
    "group\t布局容器", // 不在白名单
    "text field\tmissing value", // 没有标签
    "link\t",
    "menu item\t打开",
  ].join("\n");
  const v = elementsViewOf(readback("elements", payload));
  assert.equal(v.kind, "elements");
  assert.deepEqual(
    v.kind === "elements" ? v.items.map((e) => [e.role, e.label]) : [],
    [["button", "确定"], ["menu item", "打开"]],
  );
});

test("perceive: 元素读不到时是 unavailable，不是「一个元素都没有」", () => {
  // 改之前这里返回空数组，和「窗口里确实没有可交互控件」完全同形
  const v = elementsViewOf(readback("fault", "", "-1719", "contents", ""));
  assert.equal(v.kind, "unavailable");
  assert.equal(v.kind === "unavailable" && v.fault, "accessibility");

  const broken = elementsViewOf("乱七八糟");
  assert.equal(broken.kind, "unavailable");
  assert.equal(broken.kind === "unavailable" && broken.fault, "unknown");
});

test("perceive: 空窗口读出来是空列表，那是读数不是失败", () => {
  const v = elementsViewOf(readback("elements", ""));
  assert.deepEqual(v, { kind: "elements", items: [] });
});

/* ── 脚本本身 ───────────────────────────────────────────────────────────── */

test("perceive: 三段脚本的源码里都没有模板插值", () => {
  const hasInterpolation = (src: string) => src.includes("${");
  for (const [id, src] of Object.entries(PERCEIVE_SCRIPTS)) {
    assert.equal(hasInterpolation(src), false, `${id} 的脚本源码里有模板插值`);
  }
  // 阳性对照：不证明这个判据在工作，上面全过就什么都不说明
  assert.equal(hasInterpolation("set x to ${value}"), true, "插值检查本身失效了");
});

test("perceive: 要传应用名的两段脚本都走 on run argv", () => {
  for (const id of ["perceive.window", "perceive.elements"]) {
    const src = PERCEIVE_SCRIPTS[id] ?? "";
    assert.match(src, /on run argv/, `${id} 没有 on run argv`);
    assert.match(src, /item 1 of argv/, `${id} 没有从 argv 取应用名`);
  }
});

test("perceive: 只需自动化授权的那段里，一个无障碍调用都没有", () => {
  // 「拆开」这件事要能被检查，否则改回去也没人发现：前一段一旦重新碰窗口，
  // 它的失败就又会和权限问题混在一起。
  const front = PERCEIVE_SCRIPTS["perceive.front"] ?? "";
  assert.ok(front.length > 0);
  for (const call of ["window", "entire contents", "UI element"]) {
    assert.ok(!front.includes(call), `前台应用那段脚本里出现了无障碍调用：${call}`);
  }
  // 阳性对照：同一个判据用在窗口那段上必须命中
  assert.ok((PERCEIVE_SCRIPTS["perceive.window"] ?? "").includes("window"));
});

test("perceive: 窗口脚本先数窗口再取标题——没有这一步就分不出 none", () => {
  const src = PERCEIVE_SCRIPTS["perceive.window"] ?? "";
  const countAt = src.indexOf("count of windows");
  const nameAt = src.indexOf("name of window 1");
  assert.ok(countAt >= 0 && nameAt >= 0);
  assert.ok(countAt < nameAt, "取标题排在数窗口前面的话，零窗口会变成一次错误而不是一个结论");
  assert.match(src, /on error errMsg number errNum/, "失败必须带着错误号回来，不能被吞掉");
});
