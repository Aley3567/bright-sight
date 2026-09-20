import type { AllowedApp } from "./config.ts";
import type { CapabilityEffect } from "./types.ts";

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
 * ── 四条实测得来的 AppleScript 写法约束 ──
 * 1. 在 tell 块里对应用对象的属性做二次运算（length of、contains）会被当成远程引用，
 *    报 -1700。必须先 `set x to <属性>` 落成本地变量再运算。
 * 2. `container of` 同理不能链式写 `name of (container of n)`，要分两步。
 * 3. 保留字不能当变量名，而这张表没有文档：目前已踩中 `after`、`at`（`make new … at …`
 *    的参数名）、`st`（序数后缀，如 1st）。踩中只会在真跑时报 -2741。
 * 4. 位置定位（`window 1`、`folder "Notes"`、按 name 找笔记）在同名或多窗口场景下
 *    会静默指向错误的对象。一律改为抓住只读 id 再按 id 回读。
 *
 * 第 3 条已经有了自动门禁：test/compile.test.ts 用 osacompile 把每个模板编译一遍，
 * 不执行也不发 Apple Event，所以能无条件跑在 `npm test` 里。
 */

/**
 * destroy 在类型里存在，但运行时注册表里没有任何��条 destroy 条目——
 * 它的用处是让 policy 的第三道硬闸有可拦的东西，以及让测试能构造一条
 * 删除模板去证明闸门真的会拦。测试里那条模板不在 REGISTRY 中。
 */
export type ScriptEffect = "create" | "navigate" | "read" | "destroy";

/**
 * 脚本模板的副作用词表 → 能力词表。
 *
 * 保留两套词表而不是把 ScriptEffect 直接改掉，是因为这个映射本身是要被审查的：
 * `create` 折到 `draft` 是本次最值得商榷的一步——新建一条笔记是本地写入、不对外发送，
 * 所以是「填写但不发送」而不是「提交」。这个判断如果错了，写在这里比散在
 * 每个消费点上更容易被看见、被推翻。三个同名项保留原样，只有 create 变。
 */
const CAPABILITY_EFFECT: Readonly<Record<ScriptEffect, CapabilityEffect>> = {
  create: "draft",
  navigate: "navigate",
  read: "read",
  destroy: "destroy",
};

export function capabilityEffectOf(effect: ScriptEffect): CapabilityEffect {
  return CAPABILITY_EFFECT[effect];
}

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
 * ── 为什么不能用 `window 1` 回读 ──
 * `window 1` 是 AppleScript 的窗口叠放顺序（front to back），**和 profile 毫无关系**，
 * 也不保证就是我们刚才写入的那个窗口。实测：在另一个 profile 下新开的窗口排在 win2，
 * 原 profile 的窗口仍是 win1——也就是说即使一切设置正确，`window 1` 仍可能是别人的窗口，
 * 于是回读到的 URL 和标题都是另一个页面的。
 *
 * 这是同一类缺陷的第三次出现（前两次：同名 Notes 文件夹、同名笔记），解法也是同一个：
 * **按只读 id 定位，不按位置定位。** sdef 确认 `tab` 有 `id`（text、只读）。
 * 这里在创建的那一瞬间抓住 id，此后全程按 id 重新查找——创建那一瞬是唯一能确信
 * 「这个对象就是我刚造的」的时刻，抓住它换成 id，位置怎么变都不再影响正确性。
 *
 * 两条创建分支都是实测逼出来的：Chrome 进程在运行、`count of windows` 却返回 0
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
			set t to active tab of front window
			set URL of t to target
		else
			set t to make new tab at end of tabs of front window with properties {URL:target}
		end if
		set tid to id of t
	end tell
	repeat 40 times
		set hit to tabById(tid)
		if hit is missing value then exit repeat
		set ld to item 1 of hit
		if ld is false then exit repeat
		delay 0.25
	end repeat
	set hit to tabById(tid)
	if hit is missing value then error "刚打开的标签页已经不在了，无法回读"
	set u to item 2 of hit
	set ti to item 3 of hit
	set nt to item 4 of hit
	set nw to item 5 of hit
	return "RB1" & rs & tid & rs & u & rs & ti & rs & (nw as text) & rs & (nt as text)
end run

on tabById(tid)
	tell application "Google Chrome"
		set nw to count of windows
		set nt to 0
		set foundW to 0
		set foundI to 0
		repeat with wi from 1 to nw
			set ids to id of every tab of window wi
			set k to count of ids
			set nt to nt + k
			if foundI is 0 then
				repeat with i from 1 to k
					set thisId to item i of ids
					if thisId is tid then
						set foundW to wi
						set foundI to i
						exit repeat
					end if
				end repeat
			end if
		end repeat
		if foundI is 0 then return missing value
		set tt to tab foundI of window foundW
		set ld to loading of tt
		set u to URL of tt
		set ti to title of tt
	end tell
	return {ld, u, ti, nt, nw}
end tabById`;

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
    fields: ["tab_id", "url", "title", "windows", "tabs"],
    effect: "navigate",
    timeoutMs: 25_000,
    // tab_id 也是产物：它让 verify 能按 id 定向回读，而不是去猜哪个窗口是我们的。
    // 产物 key 沿用 active_ 前缀，因为对调用方而言它仍然是「这一步开出来的那个页面」。
    produces: {
      "chrome.tab_id": "tab_id",
      "chrome.active_url": "url",
      "chrome.active_title": "title",
    },
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
  /**
   * Chrome 的窗口与标签页计数。
   *
   * tabs 是**全部窗口的总数**，不是 `window 1` 的标签页数——新开的标签页落在哪个窗口
   * 由 Chrome 决定（profile 不同就会落在不同窗口），只数一个窗口会让 `tab_appeared`
   * 在完全正常的情况下判失败。计全局数则不论落在哪都成立。
   */
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
		set nw to count of windows
		if nw = 0 then
			return "RB1" & rs & "0" & rs & "0" & rs & "" & rs & ""
		end if
		set nt to 0
		repeat with wi from 1 to nw
			set ids to id of every tab of window wi
			set k to count of ids
			set nt to nt + k
		end repeat
		set atab to active tab of front window
		set u to URL of atab
		set ti to title of atab
	end tell
	return "RB1" & rs & (nw as text) & rs & (nt as text) & rs & u & rs & ti
end run`,
    argv: [],
    fields: ["windows", "tabs", "url", "title"],
    effect: "read",
    timeoutMs: 8_000,
  },
  /**
   * 按 tab id 定向回读。
   *
   * 和 `probe.notes-note` 同构：动作执行后不去看「最前面那个」，而是拿着创建时抓到的 id
   * 把那个对象重新找出来。找不到就如实报 found=no——标签页被用户手动关掉是正常情况，
   * 这条判据存在的意义正是把它和「开成功了」区分开。
   */
  "probe.chrome-tab": {
    id: "probe.chrome-tab",
    app: "Google Chrome",
    src: `on run argv
	set rs to ASCII character 30
	set tid to item 1 of argv
	if not (application "Google Chrome" is running) then
		return "RB1" & rs & tid & rs & "no" & rs & "" & rs & "" & rs & "no"
	end if
	tell application "Google Chrome"
		set nw to count of windows
		set foundW to 0
		set foundI to 0
		repeat with wi from 1 to nw
			set ids to id of every tab of window wi
			set k to count of ids
			repeat with i from 1 to k
				set thisId to item i of ids
				if thisId is tid then
					set foundW to wi
					set foundI to i
					exit repeat
				end if
			end repeat
			if foundI is not 0 then exit repeat
		end repeat
		if foundI is 0 then
			return "RB1" & rs & tid & rs & "no" & rs & "" & rs & "" & rs & "no"
		end if
		set tt to tab foundI of window foundW
		set u to URL of tt
		set ti to title of tt
		set isLd to loading of tt
	end tell
	set ld to "no"
	if isLd then set ld to "yes"
	return "RB1" & rs & tid & rs & "yes" & rs & u & rs & ti & rs & ld
end run`,
    argv: ["tab_id"],
    fields: ["tab_id", "found", "url", "title", "loading"],
    effect: "read",
    timeoutMs: 10_000,
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
