# Debug Session: lp-input-overlap
- **Status**: [OPEN]
- **Issue**: Live Preview 中在合并单元格相关表格里输入字符时，文本会瞬间掉到下一行并与下一行内容重叠，失焦或重新渲染后恢复。
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-lp-input-overlap.ndjson

## Reproduction Steps
1. 打开包含纵向合并单元格的表格。
2. 切到 Live Preview。
3. 将光标放到单元格文本中间，例如“对齐交”后面。
4. 通过输入法实际输入任意字符。
5. 观察输入瞬间文本是否掉到下一行、与下一行重叠，以及光标是否跟着跳到下一行。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 输入法写入期间，CodeMirror 在单元格内部插入了额外编辑层，导致 wrapper 修正命中了错误层。 | High | Low | Inconclusive |
| B | 字符写入时 LP 先局部更新行 DOM，再回填 merge 属性，中间态导致 rowspan 关系短暂失配。 | High | Medium | Confirmed |
| C | 编辑态判断没有覆盖 composition / 输入法节点，展示态样式在输入瞬间提前介入。 | High | Low | Rejected |
| D | 问题由同一行其他列实时重排触发，目标单元格只是被动受影响。 | Medium | Medium | Inconclusive |
| E | LP 表格真实高度已变化，但 CodeMirror / Obsidian 对该 widget 的高度缓存没有及时重新测量；滚动或失焦才触发恢复。 | High | Medium | Pending |

## Log Evidence
- `A`：输入法事件命中的编辑单元格为普通 `td`，`hostMerge=null`，故障并非只发生在 merge anchor 本身。
- `B`：输入后一轮日志中连续出现 `applyMergesInPlace` 的中间态与回填态，例如 `rows=2, hasMerges=false` 随后又回到 `rows=5, hasMerges=true`，说明编辑中的表格被再次跑了 merge 布局。
- `C`：`syncLpMergedCellWrapperAlignment` 已经能识别当前编辑单元格 `isEditingThisCell=true`，但故障仍然发生，说明“编辑态放行判断失效”不是主因。
- `E`：新增高度链路观测，目标是验证表格真实高度、编辑器 scroll 容器高度，以及 scroll / viewport 变化是否触发了迟到的重测。
- `E`：这轮复现日志里，输入瞬间会稳定出现两组互相矛盾的 `view` 指标：一组是 `hasFocus=true`、`domClientHeight=21`、`tableCount=0`，另一组几乎同时是 `hasFocus=false`、`domClientHeight=759`、`tableCount=3`。这说明问题已经不只是“活动表样式被改坏”，而更像是输入焦点所在的 `EditorView` 与真正承载表格 widget 的 `EditorView` 发生了脱节。

## Current Interpretation
- `applyMergesInPlace()` 对单个既有表格执行前后，`beforeHeight` 与 `afterHeight` 基本恒等，因此“单个 table 因 merge 样式变高/变矮”目前缺少证据。
- 现阶段更可疑的是 LP / CodeMirror 在输入法写入期维护了两个不同状态的视图实例：
  - 一个视图持有焦点，但高度只有一行，且查不到表格；
  - 另一个视图实际挂着 3 张表格，却在同一时刻没有焦点。
- 插件重载后页面高度异常、滚到顶部再恢复的现象，也可能属于同一条根因链，即 widget 重新挂载后某个视图的几何信息没有及时同步。

## New Evidence (Latest Reproduction)
- 新增 `viewId` 埋点后确认：真正挂着可见 LP 表格的是 `viewId=1`，其 `domClientHeight=759`、`tableCount=3`、`visibleFrom=4280`、`visibleTo=5663`。
- 但用户点击单元格并开始输入时，拿到焦点的是另外一组短生命周期视图（例如 `viewId=7/8/9`）：
  - `domClientHeight=21`
  - `tableCount=0`
  - `visibleFrom=0~26`
  - `activeSummary=\"DIV.cm-content.cm-lineWrapping\"`
- 这些 `21px` 视图会在点击/输入后被反复 `constructor -> destroy -> constructor`，且活跃元素有时会落在 `TABLE.table-editor` 上。说明 Obsidian 在表格编辑态会启用一个内嵌表格编辑器，而不是直接在外层 LP 表格 widget 上输入。
- 这解释了为什么“第一次点击还不跳，按下键盘后才跳”：真正导致问题的是输入期外层可见表格仍在被 merge 逻辑重跑，而输入实际发生在另一个临时 `EditorView` 中。

## Final Fix Attempt
- 本轮最后一次尝试不是继续改 merged cell 的 CSS，而是直接冻结输入期的 LP merge 重跑：
  - 新增 `isEmbeddedTableEditorActive(doc)`，检测 `table.table-editor` 是否处于激活态；
  - 当检测到内嵌表格编辑器激活时：
    - `update()` 阶段不再对非焦点外层视图做即时 `schedule()`；
    - `run()` 阶段直接跳过所有 LP merge DOM 变更，等输入停顿或失焦后再恢复。
- 目标：避免“外层可见 widget 被重排”去打断“内层 21px 编辑视图”的布局。

## Pits Encountered
- 仅修 `vertical-align` / `.table-cell-wrapper`，可以改善静态显示态，但解决不了输入态跳行问题。
- 仅靠 `isEditingThisCell` 或 composition 事件放行不够，因为输入实际不一定发生在可见 LP 表格 DOM 内。
- `findActiveEditingTable(doc)` 在多 `EditorView` 并存时会跨视图命中真正的表格，但当前 `run()` 所在的那个 `view` 可能根本不包含表格。
- `applyMergesInPlace()` 本身不是直接改坏单个表格高度的主因；更可能是“错误的时机对错误的视图做了正确的操作”。

## Next Observation
- 已在 `src/render/livePreview.ts` 增加新一轮最小埋点，下一次复现时会额外记录：
  - `viewId`
  - `view.dom` / `scrollDOM` 的 `isConnected`
  - `display` / `visibility`
  - `visibleRanges`
  - 当前活动元素是否真的位于该 `view` 内
  - `ViewPlugin` 的 constructor / destroy 生命周期
  - table scan 时前三张表的摘要
- 目标是确认：输入事件到底落在了哪个 `EditorView` 上，以及那个 `21px` 的焦点视图是否只是一个临时编辑壳层。

## Handoff Hint
- 如果本轮冻结策略仍不能彻底消除跳行，下一位接手者应优先考虑更激进的方案：当 `table.table-editor` 激活时，彻底暂停 LP merge 后处理，甚至只在失焦后或整块表格退出编辑态后再重新应用 merge。

## Chosen Direction
- 用户最终确认采用“方案 A”：
  - **编辑态**：主动退回普通 MD 表格，直接显示 `<` / `^^` / `||` 等源码标记；
  - **非编辑态**：继续恢复真实合并渲染。
- 当前实现方式：
  - 在 `pointerdown` 时提前记录用户即将编辑的可见 LP 表格；
  - 编辑态命中时，不再只是“跳过 merge 重跑”，而是直接调用 `renderPlainMdTableInPlace()` 清掉 `rowspan` / `colspan` / placeholder；
  - 一旦文档进入内嵌 `table.table-editor`，继续兜底保持普通 MD 表格，避免编辑时间较长时又回切到真实合并外观。
  - 后续又发现：即使已经退回普通 MD 表格，如果仍然保留 LP 展示态的固定列宽策略（`table-layout: fixed`、固定总宽、`overflow-wrap: anywhere`、`word-break: break-word`），普通表格编辑时依然可能出现换行挤压/文字重叠。
  - 因此编辑态的 `renderPlainMdTableInPlace()` 现已额外清掉这套列宽展示规则，把布局控制权尽量交还给 Obsidian 原生表格编辑器。
  - 又尝试过“当 `table-editor` 真正接管输入后，把外层 LP 表格整张 `visibility: hidden`”来彻底消除双层文字重叠，但该方案会把实际编辑所依赖的可视表格也一并隐藏，导致进入编辑模式后整张表消失，已确认回退。
  - 重新启用 `TRAE-debugger` 时发现，当前工具环境里启动的本地 HTTP Debug Server 虽然能监听 `127.0.0.1:7777`，但对 `/health` 和 `/event` 都只返回 `Empty reply`，连最简单的 `python -m http.server` 基准测试也同样异常，因此不能再把“无日志”误判为插件未加载。
  - 为了继续采证，`reportLpDebug()` 已改为“先本地追加 NDJSON，再 best-effort 发 HTTP”。当前主要证据源改为插件目录下 `.dbg/trae-debug-log-lp-input-overlap.ndjson`，HTTP 只保留为可选通道。
  - 最新宿主机日志进一步确认：进入编辑态后，视图里真正存在并承接输入的不是“外层 LP 表格 + 另一个独立 editor overlay”，而是 **`TABLE.table-editor` 本身就挂在外层 `cm-embed-block` 链路里**。
  - 关键证据：
    - `table editor dom relationship` 显示 `embeddedEditorSummary = activeEditingTableSummary = TABLE.table-editor`
    - DOM chain 为 `TABLE.table-editor -> DIV.table-wrapper -> DIV.cm-embed-block.cm-table-widget.markdown-rendered -> ...`
    - 同时 `run table scan` 在 `viewId=1` 里依然能扫到这张 6x6 表，说明插件循环里遍历到的“可见表格”里已经包含宿主原生 `table-editor`
    - 出问题的那一格在 `sync merged wrapper` 日志中出现了重复文本：`tdText` 被拼成了两遍，说明插件在编辑态又对宿主原生表格做了一次展示层回填
  - 因此本轮最终修正方向已经收敛为：**原生 `table.table-editor` 必须完全跳过插件的 LP 后处理**，不再对它执行：
    - `renderPlainMdTableInPlace()`
    - `applyMergesInPlace()`
    - 以及任何 wrapper / 列宽 / merge 语义清理逻辑
  - 当前代码已新增这一层保护，并移除了“只要 `tableEditorActive` 就兜底处理当前视图全部表格”的策略，避免再次误伤宿主编辑表。
  - 但这会带来一个副作用：输入不重叠了，编辑态里 `^^ / <` 也一起消失。
  - 因此又追加了一层更窄的修法：对 `table.table-editor` 不做整表回填，也不改当前输入单元格，只按 `TableModel` 把**非 anchor 占位格**里的源码标记（`^^ / <`）补回去。
  - 这一步的目标是同时满足两点：
    - 保住当前“不重叠”的输入稳定性；
    - 恢复编辑态里用户需要看到的合并占位语义。
  - 继续验证时又发现一个更细的小坑：当光标在右侧相邻单元格里输入时，左侧占位格的 `<` 会消失；只有把光标点回占位格本身，`<` 才重新出现。
  - 根因判断：直接往 `table-editor` 的占位格 wrapper 写文本仍然不够稳，宿主在相邻单元格获得焦点时会局部刷新该 wrapper，导致非活动占位格的 marker 被清空。
  - 当前修法：对**非活动占位格**不再依赖真实文本，而是挂 `data-tm-editor-marker`，再由 CSS `::before` 绘制 `< / ^^`；只有当前活动占位格才保留真实文本显示。

## Verification Conclusion
- 最小修复：当焦点位于某张 LP 表格内部时，暂时跳过这张“活动表”的 merge 重跑；失焦后再统一补应用。
- 新一轮调查方向：从“单元格样式兼容”转向“LP widget 高度同步 / 重新测量时机”。
