import type { AllowedApp } from "./config.ts";

/**
 * 冻结的脚本模板注册表。
 *
 * 这是整个系统的执行边界：一个动作能不能真正发出去，唯一判据是它在不在这张表里。
 * 不是"风险黑名单没拦住就放行"——动作面是从 sdef 自动长出来的，我们无法预先枚举
 * 系统会长出什么命令，黑名单在这个架构下是结构性错误。Chrome 的 `execute`
 * （执行任意 JavaScript）就是被这张表结构性排除的：它不在表里，模型即便选中也执行不了。
 *
 * 模板里没有任何插值。所有动态值走 argv，`osa()` 用 execFile 起进程（无 shell）、
 * osascript 用 `on run argv` 接收（值不进脚本字面量），两层"无需转义"叠加。
 * 测试会逐字断言每个 src 都不含 `${`。
 *
 * ── 三条实测得来的 AppleScript 写法约束 ──
 * 1. 在 tell 块里对应用对象的属性做二次运算（length of、contains）会被当成远程引用，
 *    报 -1700。必须先 `set x to <属性>` 落成本地变量再运算。
 * 2. `container of` 同理不能链式写 `name of (container of n)`，要分两步。
 * 3. `after` 是保留字，不能拿来当变量名。
 */

/**
 * destroy 在类型里存在，但运行时注册表里没有任何��条 destroy 条目——
 * 它的用处是让 policy 的第三道硬闸有可拦的东西，以及让测试能构造一条
 * 删除模板去证明闸门真的会拦。测试里那条模板不在 REGISTRY 中。
 */
export type ScriptEffect = "create" | "navigate" | "read" | "destroy";

export type ScriptTemplate = {
  id: string;
  app: AllowedApp;
  /** 脚本源码，冻结。 */
  src: string;
  /** argv 形参名，按位置。长度即 arity。 */
  argv: readonly string[];
  /** 回读字段名，按 RS 分隔顺序。字段只放短标识与计数，正文永不回传。 */
  fields: readonly string[];
  /**
   * 副作用性质，第三道硬闸。
   *
   * sdef 的动词名不足以判断后果（`close` 在 sdef 里毫不起眼，但关掉用户正在用的
   * 窗口是实打实的损失），模板作者知道后果。运行时注册表里不存在 destroy 条目——
   * 这不是"标记为危险待确认"，是根本不提供。
   */
  effect: ScriptEffect;
  /** 需要先过 HTML 转义的 argv 下标。Notes 的 body 强制走 HTML 解析，实测 `<tag>` 会被整个吞掉。 */
  htmlArgs?: readonly number[];
  timeoutMs: number;
  /** 回读字段 → 产物 key。产物与 verify 判据来自同一次回读，不是两套逻辑碰巧一致。 */
  produces?: Readonly<Record<string, string>>;
};

/**
 * Chrome 开标签页。
 *
 * 两条分支都是实测逼出来的：Chrome 进程在运行、`count of windows` 却返回 0
 * 是真实存在的状态，此时必须 make new window 再设 active tab 的 URL
 * （新窗口自带空白标签页，再 make 一个会多出一页）。
 * 有界等待 40×0.25s：搜索引擎会跳转，Google 实测 7.6 秒，超过 osa() 默认超时。
 */
const CHROME_MAKE_TAB = `on run argv
	set rs to ASCII character 30
	set target to item 1 of argv
	tell application "Google Chrome"
		if (count of windows) = 0 then
			make new window
			set URL of active tab of window 1 to target
		else
			tell window 1 to make new tab at end of tabs with properties {URL:target}
		end if
		set w to window 1
		repeat 40 times
			if not (loading of active tab of w) then exit repeat
			delay 0.25
		end repeat
		set u to URL of active tab of w
		set ti to title of active tab of w
		set nw to count of windows
		set nt to count of tabs of w
	end tell
	return "RB1" & rs & u & rs & ti & rs & (nw as text) & rs & (nt as text)
end run`;

/**
 * Notes 新建笔记。
 *
 * 容器用 `default folder of default account` 而不是 `folder "Notes"`：
 * 本机实测存在两个同名 Notes 文件夹（分属不同账号），按名字寻址会静默写错地方。
 * default 这条路径结构性唯一，问题被绕过而不是被处理。
 */
const NOTES_MAKE_NOTE = `on run argv
	set rs to ASCII character 30
	tell application "Notes"
		set c to default folder of default account
		set n to make new note at c with properties {name:(item 1 of argv), body:(item 2 of argv)}
		set theId to id of n
		set theName to name of n
		set fn to name of c
		set acct to container of c
		set an to name of acct
		set cnt to count of notes of c
	end tell
	return "RB1" & rs & theId & rs & theName & rs & fn & rs & an & rs & (cnt as text)
end run`;

/** 模型可以选的动作。在这张表里 = 能执行；不在 = 返回 Result 失败，不是异常。 */
export const REGISTRY: Readonly<Record<string, ScriptTemplate>> = {
  "Google Chrome.make-tab": {
    id: "Google Chrome.make-tab",
    app: "Google Chrome",
    src: CHROME_MAKE_TAB,
    argv: ["url"],
    fields: ["url", "title", "windows", "tabs"],
    effect: "navigate",
    timeoutMs: 25_000,
    produces: { "chrome.active_url": "url", "chrome.active_title": "title" },
  },
  "Notes.make-note": {
    id: "Notes.make-note",
    app: "Notes",
    src: NOTES_MAKE_NOTE,
    argv: ["name", "body"],
    fields: ["id", "name", "folder", "account", "count"],
    effect: "create",
    // body 要转义，name 不要：实测 name 原样保留 `<tag>` 与引号，body 则走 HTML 解析
    htmlArgs: [1],
    timeoutMs: 15_000,
    produces: { "notes.note_id": "id", "notes.note_name": "name" },
  },
};

/**
 * 只读探针，用于 verify 的前后快照与定向回读。
 *
 * 刻意与 REGISTRY 分开：模型永远选不到这里的任何一条。
 * 验证用的观察手段如果能被模型调用，"模型不参与自证"这条就守不住了。
 */
export const PROBES: Readonly<Record<string, ScriptTemplate>> = {
  "probe.chrome-counts": {
    id: "probe.chrome-counts",
    app: "Google Chrome",
    // is running 不会启动应用——观察不能有副作用，这是 observe 这一步的底线
    src: `on run argv
	set rs to ASCII character 30
	if not (application "Google Chrome" is running) then
		return "RB1" & rs & "0" & rs & "0" & rs & "" & rs & ""
	end if
	tell application "Google Chrome"
		if (count of windows) = 0 then
			return "RB1" & rs & "0" & rs & "0" & rs & "" & rs & ""
		end if
		set nw to count of windows
		set nt to count of tabs of window 1
		set u to URL of active tab of window 1
		set ti to title of active tab of window 1
	end tell
	return "RB1" & rs & (nw as text) & rs & (nt as text) & rs & u & rs & ti
end run`,
    argv: [],
    fields: ["windows", "tabs", "url", "title"],
    effect: "read",
    timeoutMs: 8_000,
  },
  "probe.notes-count": {
    id: "probe.notes-count",
    app: "Notes",
    src: `on run argv
	set rs to ASCII character 30
	tell application "Notes"
		set c to default folder of default account
		set cnt to count of notes of c
		set fn to name of c
		set acct to container of c
		set an to name of acct
	end tell
	return "RB1" & rs & (cnt as text) & rs & fn & rs & an
end run`,
    argv: [],
    fields: ["count", "folder", "account"],
    effect: "read",
    timeoutMs: 8_000,
  },
  /**
   * 按 id 回读一条笔记。
   *
   * 第二个参数是要查找的子串，包含判断在 AppleScript 里做、只回传 yes/no 和长度——
   * 正文不越过进程边界。这既守住"回读字段只放短标识"，又让 body_contains_url 可判。
   * 按 id 不按 name：同名笔记的问题和同名 folder 一样真实存在。
   */
  "probe.notes-note": {
    id: "probe.notes-note",
    app: "Notes",
    src: `on run argv
	set rs to ASCII character 30
	tell application "Notes"
		set n to note id (item 1 of argv)
		set f to container of n
		set acct to container of f
		set nm to name of n
		set pt to plaintext of n
	end tell
	set hit to "no"
	if pt contains (item 2 of argv) then set hit to "yes"
	tell application "Notes"
		set fn to name of f
		set an to name of acct
	end tell
	return "RB1" & rs & (item 1 of argv) & rs & nm & rs & fn & rs & an & rs & hit & rs & ((length of pt) as text)
end run`,
    argv: ["id", "needle"],
    fields: ["id", "name", "folder", "account", "contains", "len"],
    effect: "read",
    timeoutMs: 15_000,
  },
};

/** 模型可选动作的 id 清单。surface.ts 用它过滤动作面。 */
export function executableIds(): string[] {
  return Object.keys(REGISTRY);
}

export function templateOf(actionId: string): ScriptTemplate | undefined {
  return REGISTRY[actionId];
}

export function probeOf(id: string): ScriptTemplate | undefined {
  return PROBES[id];
}
