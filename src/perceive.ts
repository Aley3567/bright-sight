import { osa } from "./osa.ts";
import type { Snapshot, UIElement } from "./types.ts";

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
 */

/**
 * 轻快照：只问前台应用、窗口标题和运行列表。
 *
 * 大量指令（"打开浏览器"）在这一层就能决策完，不必付完整无障碍树的代价。
 * 闭环因此分两级取证：先轻后重，只有确实要操作窗口内元素时才升级。
 */
export async function snapshotLight(): Promise<Snapshot> {
  const r = await osa(`
tell application "System Events"
  set appName to name of first application process whose frontmost is true
  set wname to ""
  try
    tell process appName
      if (count of windows) > 0 then set wname to name of window 1
    end tell
  end try
  set names to name of every application process whose background only is false
  set AppleScript's text item delimiters to ", "
  set nameList to names as text
  set AppleScript's text item delimiters to ""
  return appName & linefeed & wname & linefeed & nameList
end tell`, [], { timeoutMs: 3000 });

  // 轻快照取不到说明无障碍权限缺失或 System Events 失联，属于环境问题，
  // 闭环没有可降级的路径——没有前台应用就无从判断该做什么。
  if (!r.ok) throw new Error(`轻快照失败：${r.errors.join("; ")}`);

  const [front = "", window = "", running = ""] = r.raw.split("\n");
  return {
    at: new Date().toISOString(),
    front,
    window: window || null,
    running: running.split(", ").map((s) => s.trim()).filter(Boolean),
    elements: [],
    selection: null,
  };
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

/** 完整快照：补上当前窗口内可交互元素。仅在需要操作窗口内容时调用。 */
export async function snapshotFull(): Promise<Snapshot> {
  const base = await snapshotLight();
  if (!base.window) return base;

  // entire contents 在元素极多的窗口上会很慢，超时即退回轻快照的元素为空状态，
  // 让闭环降级到"先问用户"而不是整体失败。
  //
  // 应用名走 argv：它来自 System Events，理论上可以含引号，
  // 插进脚本文本就是一条注入路径。这里连转义都不需要。
  const r = await osa(`
on run argv
tell application "System Events"
 tell process (item 1 of argv)
  set out to ""
  try
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
  end try
  return out
 end tell
end tell
end run`, [base.front], { timeoutMs: 8000 });

  // 超时或进程无无障碍权限：保持元素为空，由上层决定是降级还是提示授权
  if (!r.ok) return { ...base, elements: [] };

  const elements: UIElement[] = r.raw
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

  return { ...base, elements };
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
