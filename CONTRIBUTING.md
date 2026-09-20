# 贡献

改代码之前先读 [CLAUDE.md](CLAUDE.md)，那里写的是什么能进仓库，尤其是零硬编码与隐私默认值两条。

架构看 [docs/architecture.md](docs/architecture.md)，设计理由看 [docs/design.md](docs/design.md)。

## 开发

没有构建步骤，Node 24 直接跑 `.ts`。

```sh
npm install
npm run check      # tsc --noEmit && node --test，提交前跑这个
```

```sh
npm test           # node --test 'test/**/*.test.ts'
npm run typecheck  # tsc --noEmit
npm run test:live  # BRIGHTSIGHT_LIVE=1，跑有真实副作用的那几条
```

## 测试按「要不要真实副作用」分三档

**第一档，无条件跑。** `npm test` 的绝大多数属于这一档：

- 纯函数零 IO：`spans` 的中文语料、`policy` 的属性测试、`scripts` 的纯字符串断言
- 真实 IO 零网络：解析提交进仓库的 sdef fixture
- 假 fetch 零网络：注入 `fetch`，**断言请求体比断言响应值钱**。每个 span 都是原话的逐字子串、criteria 不含白名单外应用
- 真实子进程：`osa.test.ts` 喂 `"`、`\`、换行、emoji 以及 shell 注入样本，断言逐字节原样返回，一次性证明 argv 不变式

**第二档，静态语法门禁。** `test/compile.test.ts` 用 `osacompile` 把每个脚本模板编译一遍。只编译、不执行、不发 Apple Event，所以也无条件跑。

它挡的是 AppleScript 那张没有文档的保留字表。已经踩中的有 `after`、`at`、`st`，踩中只会在真跑的那一刻报 -2741。这条测试自带阳性对照：拿一段已知会失败的脚本去编译，确认门禁本身没有失效。

**第三档，真实副作用。** `BRIGHTSIGHT_LIVE=1` 才跑。真建一条笔记、真开一个标签页，按 id 回读验证，再按 id 删掉或关掉。

别人跑 `npm test` 不该被要求先去系统设置里授自动化权限，所以这一档默认 skip。

## 加一条新动作

1. 在 `src/scripts.ts` 的注册表里加模板。值永远走 `argv`，不插进脚本文本
2. 在 `src/verify.ts` 里加配套的前后对照探针。有测试断言「每个可执行动作都有配套探针」，漏了会红
3. `npm run check` 会自动把新模板纳入 `osacompile` 门禁
4. 如果新动作有破坏性，在 spec 或模板上标出来。硬闸取或，标了就拦得住

## 提交前

- `npm run check` 全绿
- 新增落盘的文件要显式给权限，不听凭 umask。参考 `journal.ts`、`settings.ts`、`actions.ts` 的写法
- 不要硬编码任何本机路径、profile 目录名、邮箱、端口。判断标准不是「这条信息敏感吗」，而是「别人的机器上这条信息还对吗」
- 新增策略分支要补一个「新旧分支同时可能命中」的测试。只测新逻辑的顺风路径会让缺陷全绿通过
- 任何「0 命中 / 没找到 / 很干净」的结论必须配阳性对照

## 已知的坑

改脚本模板之前必读 `src/scripts.ts` 的文件头注释。四类踩过的坑记在那里：远程引用 -1700、`container of` 不能链式、没有文档的保留字表、位置定位静默指错对象。

最后一条值得单独记住：**按只读 id 定位，永远不按位置。** `window 1` 是层叠顺序而不是「我刚开的那个」。这个缺陷类在本项目里出现过四次，其中一次是 live 测试自己的清理代码，那条会关掉用户正在用的页面。
