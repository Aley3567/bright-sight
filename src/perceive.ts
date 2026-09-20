import { OSA_TIMEOUT, osa, parseReadback } from "./osa.ts";
import type { AxFault, ElementsView, Snapshot, UIElement, WindowView } from "./types.ts";

/**
 * 感知层：不截图，只读操作系统主动暴露的结构化语义。
 *
 * 对照数据（本机实测）：一帧屏幕截图约 2.4MB 像素，交给视觉模型还需约 1500 token；
 * 同一时刻的无障碍树是二十余个带角色和标签的节点，序列化后不足 2KB。
 * 更关键的差别不在体积而在歧义——像素要模型自己推断"那个方块是不是按钮"，
 * 无障碍树直接写着 role=button，这一步推断本就不该由模型承担。
 *
 * 所有 osascript 调用都经 osa.ts，本文件不自己 spawn 子进程：
 * 执行通道只留一个可审计出口，值一律走 argv。
 *
 * ── 为什么这里的脚本按「需要哪种授权」切开 ──
 * 「前台应用叫什么名字」「有哪些应用在跑」走的是 System Events 的进程套件，
 * 只需要**自动化**授权；「那个进程有几个窗口、窗口叫什么、窗口里有什么控件」
 * 走的是无障碍 API，需要**辅助功能**授权。两者曾经拼在同一段脚本里，
 * 后半段用 `try … end try` 兜住——于是缺辅助功能授权和「这个应用真的没有窗口」
 * 落成同一个 `window: null`，既没有日志也没有提示。切开之后，
 * 后半段的失败带着错误号回到 TS 侧，由 WindowView / ElementsView 如实表达。
 */

/**
 * 前台应用与运行列表：只需自动化授权。
 *
 * 这一段刻意不含任何无障碍调用，所以它的失败只有一种解释（发不进 System Events），
 * 不需要分类。也正因如此它可以继续用「取不到就抛」的老规矩。
 */
const FRONT_SRC = `tell application "System Events"
  set appName to name of first application process whose frontmost is true
  set names to name of every application process whose background only is false
  set AppleScript's text item delimiters to ", "
  set nameList to names as text
  set AppleScript's text item delimiters to ""
  return appName & linefeed & nameList
end tell`;

/**
 * 前台窗口：需要辅助功能授权。
 *
 * 三点写法上的讲究：
 *
 * 1. **`on error` 把错误号带回来，而不是吞掉。** 错误号是语言无关的判据——
 *    本机实测 osascript 的错误文本跟随系统语言，靠文本分类换个语言环境就失效。
 * 2. **`stg` 记录失败发生在哪一步。** -1719 既是「无效的索引」又是 System Events
 *    报告「不允许辅助访问」时用的号，两种含义必须靠位置区分：第一次触碰无障碍 API
 *    就失败才可能是权限问题，后面失败只能是索引问题。
 * 3. **先数窗口再取标题。** `count of windows` 为 0 时直接回答「没有窗口」，
 *    这是唯一能把「确实没有」和「看不到」分开的办法。
 *
 * 应用名走 argv，脚本文本里没有任何插值。
 * 这里按 `window 1` 定位是例外而非违例：目标就是「前台进程的最前那个窗口」，
 * 它不是我们创建的对象，没有 id 可抓，位置本身就是判据。
 */
const WINDOW_SRC = `on run argv
	set rs to ASCII character 30
	set stg to "reach"
	try
		tell application "System Events" to tell process (item 1 of argv) to set wcount to count of windows
		if wcount is 0 then return "RB1" & rs & "none" & rs & "" & rs & "" & rs & "" & rs & ""
		set stg to "name"
		tell application "System Events" to tell process (item 1 of argv) to set wname to name of window 1
	on error errMsg number errNum
		return "RB1" & rs & "fault" & rs & "" & rs & errNum & rs & stg & rs & errMsg
	end try
	if wname is missing value then set wname to ""
	return "RB1" & rs & "window" & rs & wname & rs & "" & rs & "" & rs & ""
end run`;

/**
 * 窗口内可交互元素：同样需要辅助功能授权。
 *
 * 外层的 `try` 不再吞错，改为把错误号回传；内层逐元素的 `try` 保留——
 * 遍历过程中某个控件消失是真实且频繁的，让一个控件带走整棵树不划算。
 * 这两层 try 的区别就是「预期内的局部失败」与「整段读不到」的区别。
 */
const ELEMENTS_SRC = `on run argv
	set rs to ASCII character 30
	set out to ""
	set stg to "contents"
	try
		tell application "System Events"
			tell process (item 1 of argv)
				set els to entire contents of window 1
				set n to count of els
				-- 元素极多的窗口全量遍历会拖垮延迟，超出上限即截断：
				-- 决策层只需要可操作的候选，不需要完整的树。
				if n > 200 then set n to 200
				repeat with i from 1 to n
					try
						set e to item i of els
						set r to (class of e) as text
						set lbl to ""
						try
							set lbl to (title of e) as text
						end try
						if lbl is "" then
							try
								set lbl to (description of e) as text
							end try
						end if
						if lbl is "" then
							try
								set lbl to (value of e) as text
							end try
						end if
						set out to out & r & tab & lbl & linefeed
					end try
				end repeat
			end tell
		end tell
	on error errMsg number errNum
		return "RB1" & rs & "fault" & rs & "" & rs & errNum & rs & stg & rs & errMsg
	end try
	return "RB1" & rs & "elements" & rs & out & rs & "" & rs & "" & rs & ""
end run`;

/**
 * 交给静态门禁的脚本清单。
 *
 * 这些脚本不在 `scripts.ts` 的注册表里（它们是只读感知，不是可被模型选中的动作），
 * 但同样要过 `test/compile.test.ts` 的两道检查：osacompile 真编译一遍，以及源码里不含模板插值。
 * 导出它们就是为了让那道门禁能够够到——绕过门禁的新模板迟早会在真跑时报 -2741。
 */
export const PERCEIVE_SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  "perceive.front": FRONT_SRC,
  "perceive.window": WINDOW_SRC,
  "perceive.elements": ELEMENTS_SRC,
});

/** 窗口与元素两段脚本共用的回读字段表。 */
const AX_FIELDS = ["state", "payload", "code", "stage", "message"] as const;

/**
 * 第一次触碰无障碍 API 的那一步。
 *
 * -1719 在这些步骤上读作「缺辅助功能授权」，在其他步骤上只能读作「无效的索引」：
 * 我们在取窗口标题之前已经自己确认过窗口数大于 0，真正的索引越界只可能来自竞态。
 */
const FIRST_AX_STAGE = new Set(["reach", "contents"]);

/**
 * AppleScript 错误号 → 故障分类。纯函数，零 IO，可被穷举测试。
 *
 * 号码的来源：
 * - `-1743` = `errAEEventNotPermitted`（SDK 的 AppleEvents.h 原话：
 *   "the target of the AppleEvent does not allow this sender to execute this event"），
 *   也就是自动化授权被拒。本机 `osascript -e 'error number -1743'` 实测消息为
 *   「未获得授权将Apple事件发送给…」。
 * - `-25211` = `kAXErrorAPIDisabled`（SDK 的 AXError.h），无障碍 API 被关闭。
 * - `-1719` = `errAEIllegalIndex`（本机实测消息「无效的索引」），但 System Events
 *   报告「不允许辅助访问」时用的也是它——二进制里确有
 *   `%@ is not allowed assistive access.` 这条字面量。靠 `stage` 消歧，见上。
 *
 * 认不出的号码一律 `unknown`，绝不退回「没有窗口」。
 */
export function axFaultOfCode(code: number, stage: string): AxFault {
  if (code === -1743) return "automation";
  if (code === -25211) return "accessibility";
  if (code === -1719 && FIRST_AX_STAGE.has(stage)) return "accessibility";
  return "unknown";
}

/** 每类故障对应的一句人话，直接可以打给用户看。 */
export function explainAxFault(fault: AxFault): string {
  switch (fault) {
    case "accessibility":
      return "缺少「辅助功能」授权，看得到应用但看不到它的窗口";
    case "automation":
      return "缺少「自动化」授权，发不进 System Events";
    case "timeout":
      return "读取无障碍信息超时";
    case "unknown":
      return "读取无障碍信息失败，原因未能识别";
  }
}

/**
 * 从 osascript 的一行错误文本里抠出错误号。
 *
 * 实测格式（本机，中文环境）：
 * `0:18: execution error: 未获得授权将Apple事件发送给current application。 (-1743)`
 * 号码在行尾括号里，前面那段消息是本地化的。取最后一个括号数字，
 * 因为消息正文里理论上也可能出现形如 `(-1)` 的片段。
 */
export function axErrorNumber(text: string): number | null {
  const hits = [...text.matchAll(/\((-\d{1,6})\)/g)];
  const last = hits.at(-1);
  return last ? Number(last[1]) : null;
}

export type AxFailure = { fault: AxFault; detail: string };

/**
 * 整段脚本没跑成时（超时、osascript 自己炸了）按错误文本分类。
 *
 * 脚本自己的 `on error` 够得着的错误都走结构化回读，走到这里的是够不着的那些。
 * 抠不出错误号就是 `unknown`——fail-closed，不猜。
 */
export function axFailureOfText(text: string): AxFailure {
  if (text.includes(OSA_TIMEOUT)) return { fault: "timeout", detail: explainAxFault("timeout") };
  const code = axErrorNumber(text);
  if (code === null) return { fault: "unknown", detail: `${explainAxFault("unknown")}：${text.slice(0, 160)}` };
  const fault = axFaultOfCode(code, "reach");
  return { fault, detail: detailOf(fault, code, "reach", text) };
}

/**
 * 故障详情。
 *
 * 只有 `unknown` 才把 AppleScript 的原始消息带上：认出来的故障，那句本地化消息
 * 不提供任何额外信息，却可能夹带窗口标题或应用名。认不出来的时候它是唯一线索，
 * 这时值得带，并且截断。detail 只给人看，不进留痕。
 */
function detailOf(fault: AxFault, code: number, stage: string, message: string): string {
  const head = `${explainAxFault(fault)}（错误号 ${code}，阶段 ${stage}）`;
  const tail = message.trim();
  return fault === "unknown" && tail ? `${head}：${tail.slice(0, 160)}` : head;
}

/**
 * 把窗口脚本的回读翻成 WindowView。
 *
 * 所有认不出的形状——回读损坏、字段数不对、state 是没见过的词——都落到
 * `unavailable` 而不是 `none`。这是本次改动的核心不变式：`none` 是一个**结论**，
 * 只能由脚本明确回答「窗口数为 0」得出，不能由「没看懂」兜底得出。
 */
export function windowViewOf(raw: string): WindowView {
  const p = parseReadback(raw, AX_FIELDS);
  if (!p.ok) return { kind: "unavailable", fault: "unknown", detail: p.errors.join("；") };
  const v = p.values;
  if (v.state === "window") return { kind: "window", title: v.payload ?? "" };
  if (v.state === "none") return { kind: "none" };
  const code = Number(v.code);
  if (v.state !== "fault" || !Number.isFinite(code)) {
    return { kind: "unavailable", fault: "unknown", detail: `回读状态无法识别：${JSON.stringify(v.state).slice(0, 80)}` };
  }
  const stage = v.stage ?? "";
  const fault = axFaultOfCode(code, stage);
  return { kind: "unavailable", fault, detail: detailOf(fault, code, stage, v.message ?? "") };
}

/** 把元素脚本的回读翻成 ElementsView。失败分类与窗口那段共用同一套判据。 */
export function elementsViewOf(raw: string): ElementsView {
  const p = parseReadback(raw, AX_FIELDS);
  if (!p.ok) return { kind: "unavailable", fault: "unknown", detail: p.errors.join("；") };
  const v = p.values;
  if (v.state === "elements") return { kind: "elements", items: parseElements(v.payload ?? "") };
  const code = Number(v.code);
  if (v.state !== "fault" || !Number.isFinite(code)) {
    return { kind: "unavailable", fault: "unknown", detail: `回读状态无法识别：${JSON.stringify(v.state).slice(0, 80)}` };
  }
  const stage = v.stage ?? "";
  const fault = axFaultOfCode(code, stage);
  return { kind: "unavailable", fault, detail: detailOf(fault, code, stage, v.message ?? "") };
}

/**
 * `Snapshot.window` 这个扁平字段的取值。
 *
 * 只有真读到了非空标题才给字符串。看不到和没有窗口都是 null——这正是旧行为，
 * 保留它是为了不改动决策层与留痕；**区分在 `windowView` 里，不在这里**。
 */
export function windowTitleOf(view: WindowView): string | null {
  return view.kind === "window" && view.title !== "" ? view.title : null;
}

/**
 * 轻快照：只问前台应用、窗口标题和运行列表。
 *
 * 大量指令（"打开浏览器"）在这一层就能决策完，不必付完整无障碍树的代价。
 * 闭环因此分两级取证：先轻后重，只有确实要操作窗口内元素时才升级。
 *
 * 两次 osascript 而不是一次，多付的是一次进程启动（本机实测约 18ms）。
 * 换来的是「窗口读不到」有了独立的、可分类的失败通道。
 */
export async function snapshotLight(): Promise<Snapshot> {
  const r = await osa(FRONT_SRC, [], { timeoutMs: 3000 });

  // 前台应用取不到说明自动化授权缺失或 System Events 失联，属于环境问题，
  // 闭环没有可降级的路径——没有前台应用就无从判断该做什么。
  if (!r.ok) throw new Error(`轻快照失败：${r.errors.join("; ")}`);

  const [front = "", running = ""] = r.raw.split("\n");
  const windowView = await readWindow(front);
  return {
    at: new Date().toISOString(),
    front,
    window: windowTitleOf(windowView),
    windowView,
    running: running.split(", ").map((s) => s.trim()).filter(Boolean),
    elements: [],
    selection: null,
  };
}

async function readWindow(app: string): Promise<WindowView> {
  // 没有应用名就不发这次 Apple Event：拼一个空的进程名过去只会换回一条
  // 看不懂的错误，不如直说「前提没成立」。
  if (!app) return { kind: "unavailable", fault: "unknown", detail: "没有取到前台应用名，无从查询窗口" };
  const r = await osa(WINDOW_SRC, [app], { timeoutMs: 3000 });
  if (!r.ok) return { kind: "unavailable", ...axFailureOfText(r.errors.join("；")) };
  return windowViewOf(r.raw);
}

/**
 * 无障碍角色白名单。
 *
 * 过滤纯布局与装饰节点（group / splitter / 滚动条部件），它们占了树里多数节点，
 * 却没有任何一个是用户会说"点它"的东西。剔掉后送进决策层的选项才是可操作的。
 */
const INTERACTIVE = new Set([
  "button", "radio button", "check box", "pop up button", "menu button",
  "menu item", "text field", "text area", "link", "tab", "list item",
  "combo box", "slider", "disclosure triangle", "image",
]);

/**
 * 完整快照的返回类型。
 *
 * `elementsView` 只挂在这里而不是挂进 `Snapshot`：轻快照从来不问元素，
 * 给它一个「没问过」的态等于在类型里承认那条路没接通，是另一件事。
 * 这里保持现状——`Snapshot.elements` 在轻快照里恒为空数组。
 */
export type FullSnapshot = Snapshot & { elementsView: ElementsView };

/** 完整快照：补上当前窗口内可交互元素。仅在需要操作窗口内容时调用。 */
export async function snapshotFull(): Promise<FullSnapshot> {
  const base = await snapshotLight();

  // 没有窗口就没有窗口内元素，这是读数不是失败；看不到窗口时也不再问一遍，
  // 那只会把同一条权限失败重复触发一次，而原因 windowView 已经说清楚了。
  if (base.windowView.kind === "none") return { ...base, elementsView: { kind: "elements", items: [] } };
  if (base.windowView.kind === "unavailable") {
    const { fault, detail } = base.windowView;
    return { ...base, elementsView: { kind: "unavailable", fault, detail } };
  }

  // entire contents 在元素极多的窗口上会很慢，超时是预期内的失败，
  // 但它和「没有权限看」不是一回事，所以两者在 elementsView 里分得开。
  //
  // 应用名走 argv：它来自 System Events，理论上可以含引号，
  // 插进脚本文本就是一条注入路径。这里连转义都不需要。
  const r = await osa(ELEMENTS_SRC, [base.front], { timeoutMs: 8000 });
  const elementsView: ElementsView = r.ok
    ? elementsViewOf(r.raw)
    : { kind: "unavailable", ...axFailureOfText(r.errors.join("；")) };

  return {
    ...base,
    elements: elementsView.kind === "elements" ? elementsView.items : [],
    elementsView,
  };
}

function parseElements(payload: string): UIElement[] {
  return payload
    .split("\n")
    .map((line, i) => {
      const [role = "", label = ""] = line.split("\t");
      const clean = label.trim();
      // AppleScript 的 missing value 经 osascript 会原样变成这个字符串，
      // 不滤掉就会把"没有标签"当成一个叫 missing value 的标签送进决策层。
      return {
        role: role.trim(),
        label: clean === "missing value" ? "" : clean.slice(0, 120),
        index: i,
      };
    })
    // 无标签元素（滚动条箭头等）用户无法用自然语言指称，留着只是噪声
    .filter((e) => INTERACTIVE.has(e.role) && e.label.length > 0);
}

/**
 * 读取当前选中文本。
 *
 * 刻意不走"模拟 Cmd+C 再读剪贴板"这条常见捷径：那会覆盖用户剪贴板，
 * 是感知动作产生副作用，违背只读取不改变的原则。这里只问无障碍树里的选中值，
 * 拿不到就返回 null，由上层向用户澄清。
 */
export async function selectedText(): Promise<string | null> {
  const r = await osa(`
tell application "System Events"
  set appName to name of first application process whose frontmost is true
  tell process appName
    try
      return value of attribute "AXSelectedText" of (first UI element whose focused is true)
    end try
  end tell
  return ""
end tell`, [], { timeoutMs: 3000 });
  if (!r.ok) return null;
  return r.raw || null;
}
