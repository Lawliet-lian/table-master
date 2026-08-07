# Table Master 列宽拖拽与本地持久化技术方案

## 1. 文档目的

本文档用于指导 Table Master 实现“像 Excel 一样拖拽调整列宽，并把列宽持久化到 Markdown 源文件”的完整设计与分阶段落地。

后续 AI 或人工开发必须以本文档为准，遵循以下原则：

1. 不允许一次性大改全链路后再统一验收。
2. 必须按阶段推进，每个阶段完成后都要人工验收通过，才能进入下一阶段。
3. 如果实施中发现本文档与实际代码存在冲突，应先更新本文档，再继续开发。

---

## 2. 背景与问题定义

当前插件已经具备：

- Markdown 表格解析与序列化
- 阅读视图表格重建渲染
- Live Preview 轻量合并渲染
- 网格编辑器
- 编辑器内表格操作（插入、删除、移动、排序、合并等）

但目前**不支持列宽拖拽**，也**没有列宽持久化模型**。

如果只是在某个视图里临时改 DOM 宽度，而不打通“源文件 -> 解析 -> 模型 -> 渲染 -> 回写 -> 再编辑”整条链路，会出现以下问题：

1. 列宽无法稳定保存到本地 Markdown。
2. 阅读视图、Live Preview、网格编辑器显示不一致。
3. 任何插列、删列、移列操作都可能让列宽元数据失配。
4. Live Preview 若直接重写 table widget 内部 DOM，可能触发 CodeMirror/Obsidian 渲染退化。

---

## 3. 目标与非目标

### 3.1 目标

本方案的目标是：

1. 用户可以在网格编辑器中拖拽列边界调整列宽。
2. 用户可以在 Live Preview 中拖拽列边界调整列宽。
3. 列宽信息持久化保存到当前 Markdown 文件中。
4. 阅读视图、Live Preview、网格编辑器都能读取并应用同一份列宽数据。
5. 插列、删列、移列等操作后，列宽数据仍保持一致。

### 3.2 非目标

本方案暂不覆盖：

1. 自动适配不同主题的复杂响应式列宽算法。
2. 百分比宽度与像素宽度混合编辑器 UI。
3. 不同视图独立保存不同列宽。
4. 对原生 HTML `<table>` 手写源码做复杂双向编辑体验优化。

第一阶段默认只支持**像素宽度**持久化。

---

## 4. 当前代码基线

当前相关链路如下：

### 4.1 数据模型层

- `src/table/model.ts`
- `src/table/parser.ts`
- `src/table/serializer.ts`
- `src/table/ops.ts`

当前 `TableModel` 中仅包含：

- `rows`
- `aligns`
- `headerRows`
- `cols`
- `caption`
- `tbodyBreaks`

还**没有列宽字段**。

### 4.2 编辑器操作链路

- `src/editor/tableLocator.ts`
- `src/editor/actions.ts`

当前表格操作流程是：

1. `locateTable()` 找到当前表格块
2. `parseTable()` 解析为 `TableModel`
3. 调用 `ops.*` 修改模型
4. `serialize()` 写回 Markdown

这说明列宽如果不进入 `TableModel` 和序列化链路，就一定会在编辑动作后丢失。

### 4.3 阅读视图渲染

- `src/render/postProcessor.ts`
- `src/render/tableRenderer.ts`

当前阅读视图会重新解析 Markdown 表格，再重建 DOM。

### 4.4 Live Preview 渲染

- `src/render/livePreview.ts`
- `src/main.ts`

当前 Live Preview 采用“轻量 DOM 变更”策略，只改：

- `rowspan`
- `colspan`
- placeholder 的隐藏样式

**不能粗暴重建整个表格 DOM**，否则存在退化风险。

### 4.5 网格编辑器

- `src/ui/gridEditorModal.ts`

当前支持单元格选择、编辑、插删行列、合并拆分，但没有列宽模型与拖拽手柄。

---

## 5. 总体设计结论

本功能必须采用：

**Markdown 结构化元数据持久化 + TableModel 扩展 + 多视图统一读取 + 分阶段渐进启用**

不采用“仅 DOM 临时宽度”的方案。

### 5.1 持久化格式

列宽信息保存在表格邻近位置的 HTML 注释中：

```markdown
<!-- tm-colwidths: 120|180|240 -->

| Name | Team | Note |
| --- | --- | --- |
| A | X | ... |
```

约束如下：

1. 注释默认放在表格块上方。
2. 第一版仅允许整数像素值。
3. 列数必须与逻辑列数一致。
4. 如果列宽数据非法，则解析时忽略，并回退到自动宽度。
5. **空行规则（Obsidian 原生块边界规避）**：
   - 扩展 GFM 格式下，若表格**没有 caption 行**，必须在 `<!-- tm-colwidths: ... -->` 与下一行 `| 表头 |` / 分隔行之间**插入 1 行空行**，避免 Obsidian Live Preview / 源码视图下 HTML 注释与 GFM 表头被合并到同一个 paragraph 块，从而导致表格退化为源码文本不渲染。
   - 扩展 GFM 格式下，若表格**存在 caption 行**，允许 `colWidths` 注释与 `[caption]` 紧邻；`[caption]` 本身能被 Obsidian 原生解析器识别为独立结构块，因此 caption 再紧邻 `| 表头 |` 时无需额外空行（保持与 Table Extended 历史约定一致）。
   - HTML `<table>` 输出格式下，只要写出了 `colWidths` 注释，就固定在注释与 `<table>` 之间空 1 行，保证 HTML 块级边界判定稳定。
   - 兼容性：parseTable 侧仍允许“注释紧挨着表头（无空行）”的历史写法正常解析；只是 Table Master 自己序列化 / 应用写回时会按上述规则**自动规范化**为带空行版本，避免用户再遇到 LP 不渲染问题。
6. **推荐 caption 统一上方**：Table Master 自己序列化时 caption 永远写在表头上方；parseTable 仍保持“上方 / 下方都能识别”的宽松兼容，以支持历史笔记。

### 5.2 为什么选注释

原因：

1. 不破坏现有 Markdown 表格语法。
2. 对用户可见但干扰小。
3. 便于解析和序列化。
4. 与 caption 的“表格邻近元数据”模式一致。

---

## 6. 目标架构

完整数据流如下：

```text
Markdown 源文件
  -> tableLocator / collectTableSources 识别表格块与列宽注释
  -> parser 解析为 TableModel.colWidths
  -> 编辑操作 / 网格编辑器 / 拖拽逻辑修改 TableModel.colWidths
  -> serializer 把 colWidths 写回 Markdown 注释
  -> postProcessor / livePreview / gridEditorModal 统一读取并渲染
```

### 6.1 新增数据字段

在 `TableModel` 中新增：

```ts
colWidths?: number[];
```

语义：

- 数组下标对应逻辑列索引
- 值为像素宽度
- `undefined` 表示当前表没有显式列宽配置

### 6.2 新增结构行类型

当前代码只识别：

- 表格正文行
- 分隔行
- caption 行

方案要求新增：

- `colWidths` 注释行

并把它视为与 caption 同级的**结构行**。

### 6.3 新增渲染载体

统一使用 `<colgroup>` / `<col>` 应用列宽：

```html
<table>
  <colgroup>
    <col style="width: 120px" />
    <col style="width: 180px" />
    <col style="width: 240px" />
  </colgroup>
  ...
</table>
```

这样阅读视图、Live Preview、网格编辑器都能使用同一策略。

---

## 7. 模块级设计

## 7.1 `src/table/model.ts`

需要改动：

1. `TableModel` 增加 `colWidths?: number[]`
2. `cloneModel()` 同步复制 `colWidths`
3. `emptyModel()` 默认不设置 `colWidths`

约束：

1. `colWidths` 长度必须等于 `cols`
2. 如果长度不一致，调用方必须在进入渲染前归一化

---

## 7.2 `src/table/parser.ts`

需要新增能力：

1. 解析列宽注释行，例如：
   - `<!-- tm-colwidths: 120|180|240 -->`
2. 支持表格上方的列宽注释
3. 支持表格下方的列宽注释（可选，第一版建议先不支持，降低复杂度）
4. 将解析结果写入 `TableModel.colWidths`

建议新增函数：

```ts
function parseColWidths(line: string): number[] | null
function isColWidthsLine(line: string): boolean
```

解析规则：

1. 去掉注释包裹
2. 读取 `tm-colwidths:` 后的内容
3. 使用 `|` 分隔
4. 每项必须为正整数
5. 列数不匹配则整体忽略

注意：

1. `parseTable()` 不仅要识别注释，还要在构建逻辑行前把注释剥离掉，避免误判成 header/body 行。
2. 第一版建议只支持**表格上方**的列宽注释，这样能显著降低块识别和回写复杂度。

---

## 7.3 `src/table/serializer.ts`

需要新增能力：

1. 把 `model.colWidths` 序列化为注释行
2. 在 extended 格式下输出到表格上方
3. 在 html 输出格式下，仍建议同时输出注释，保证切换输出格式后元数据不丢失

建议新增函数：

```ts
function colWidthsLine(model: TableModel): string | null
```

输出规则：

1. `colWidths` 不存在时不输出
2. `colWidths.length !== model.cols` 时不输出
3. 输出格式固定为：

```markdown
<!-- tm-colwidths: 120|180|240 -->
```

建议输出顺序：

1. 先输出列宽注释
2. 再输出 caption
3. 再输出表格主体

原因：

1. 列宽属于结构元数据，优先级高于 caption
2. 输出顺序固定后，后续 AI 改动更容易保持一致

---

## 7.4 `src/table/ops.ts`

这是方案里最容易漏掉的核心点。

所有列操作都必须同步维护 `colWidths`：

### 插列

- `insertCol()`
- 在插入位置插入一个默认宽度项

默认宽度建议：

```ts
const DEFAULT_COL_WIDTH = 160;
```

### 删列

- `deleteCol()`
- 删除对应列宽

### 移列

- `moveCol()`
- 同步交换 `colWidths[col]` 和 `colWidths[target]`

### 新建表

- `emptyModel()`
- 第一版不主动生成 `colWidths`

只有当用户实际拖动后，才开始生成 `colWidths`

---

## 7.5 `src/editor/tableLocator.ts`

必须扩展“结构行”定义。

当前只认 caption，不认列宽注释。需要新增：

```ts
function isColWidthsLine(line: string): boolean
```

并修改：

```ts
isStructuralTableLine()
```

使其包含：

1. table line
2. separator line
3. caption line
4. colWidths line

原因：

1. 编辑器内任意表格动作都依赖 `locateTable()`
2. 如果列宽注释不在 block 内，后续 `replaceRange` 会把表格正文改掉，但旧注释残留在块外，造成元数据陈旧

---

## 7.6 `src/editor/actions.ts`

需要新增和修正两类逻辑。

### 7.6.1 现有链路兼容

`computeCursorPos()` 必须跳过列宽注释行，否则任何编辑动作回写后，光标都会偏移。

需要把“应跳过的非逻辑行”统一抽成共享判断，例如：

```ts
function isNonLogicalTableMetaLine(line: string): boolean
```

包含：

1. separator
2. blank
3. caption
4. colWidths 注释

### 7.6.2 新增保存入口

后续拖拽完成后，需要一个可复用的保存入口，把更新后的模型写回源文档。

建议不要新造第二套“只更新注释”的特殊写法，而是继续复用：

1. `locateTable()`
2. `parseTable()`
3. 修改 `model.colWidths`
4. `serialize()`
5. `applyModel()`

这样可保持单一写回路径。

---

## 7.7 `src/render/tableRenderer.ts`

阅读视图重建 DOM 时要应用列宽。

新增函数建议：

```ts
function appendColGroup(table: HTMLTableElement, model: TableModel): void
```

执行顺序建议：

1. 清空 `table.innerHTML`
2. 写入 `<caption>`（如有）
3. 写入 `<colgroup>`（如有 `colWidths`）
4. 写入 `thead`
5. 写入 `tbody`

### 关键修正

`modelSignature()` 必须纳入 `colWidths`，否则：

1. 仅列宽变化
2. 表格内容未变化
3. `applyModelToTable()` 会误判为无需更新

建议增加：

```ts
JSON.stringify(model.colWidths ?? [])
```

---

## 7.8 `src/render/postProcessor.ts`

阅读视图源块收集必须把 `colWidths` 注释作为结构行纳入，否则表格块与解析结果不一致。

建议：

1. 不要在本文件单独维护另一套正则
2. 抽公共方法，例如：
   - `isCaptionLine`
   - `isColWidthsLine`
   - `isStructuralTableLine`

避免三处逻辑分叉。

3. **分块规则额外约束**（对应 5.1 空行规则）：允许 `colWidths` 注释行与后续 `[caption]` 行 / `| 表头 |` 行 / 分隔行之间存在 **0~1 行空行**，仍视为同一张表的结构块；只有满足“连续 2 行以上空行”或“遇到非结构行”时才判定为不同表的切分点（沿用项目现有“双空行切表”策略，降低改动面）。

---

## 7.9 `src/render/livePreview.ts`

这是风险最高的模块，必须单独约束。

### 核心原则

**不要直接重建或深度改写 Live Preview 里的 table widget 内部 DOM。**

当前模块已经证明：

1. 整表重建会干扰 CodeMirror widget
2. 异步大改 DOM 存在退化风险

### 正确方案

Live Preview 的列宽支持拆为两部分：

#### A. 被动渲染宽度

在当前轻量策略基础上，尽量只做安全样式写入：

1. 给 table 或 col 元素设置宽度
2. 不触碰单元格内部文本结构

#### B. 主动拖拽手柄

拖拽手柄采用**overlay 层**，不要插进表格单元格内部。

建议方式：

1. 通过 `getBoundingClientRect()` 计算列边界
2. 在编辑器外层挂绝对定位的拖拽线/手柄
3. 拖动过程中只更新 overlay 位置和视觉反馈
4. 鼠标释放时一次性回写 `colWidths`

禁止方式：

1. 在每个 `<th>` 内插入复杂交互节点
2. 拖动时不断重建 `<table>`
3. 拖动过程中频繁触发整表 re-render

---

## 7.10 `src/ui/gridEditorModal.ts`

网格编辑器是最适合作为第一阶段交互入口的地方，因为它不受 Live Preview widget 限制。

需要新增：

1. `<colgroup>` 渲染
2. 表头列宽拖拽手柄
3. 拖拽中的视觉反馈
4. 修改 `this.model.colWidths`
5. 插删移列后同步更新显示

建议：

1. 第一版只在表头右侧显示手柄
2. 手柄宽度 4px 到 6px
3. 拖动时设置最小宽度，例如 80px
4. 拖动结束后只更新模型，不立即写文件
5. 仍然通过“应用”按钮统一写回 Markdown

这会显著降低第一阶段风险。

---

## 8. 公共约束与归一化规则

为避免后续实现分叉，定义以下统一规则。

### 8.1 列宽最小值

```ts
MIN_COL_WIDTH = 80
DEFAULT_COL_WIDTH = 160
```

### 8.2 非法值处理

若解析到以下情况，视为无效列宽：

1. 非数字
2. 小于最小宽度
3. 与列数不一致

处理策略：

1. 解析阶段忽略整组 `colWidths`
2. 渲染阶段回退到自动宽度

### 8.3 归一化策略

当用户第一次拖动时：

1. 若 `model.colWidths` 不存在，则基于当前渲染宽度生成完整数组
2. 后续所有操作只维护数组，不再混用“部分有值、部分无值”

### 8.4 输出稳定性

序列化必须保证：

1. 相同模型输出相同文本
2. 不要同一表时而上方注释、时而下方注释
3. 不要混用空格风格

---

## 9. 分阶段实施计划

本功能改动较大，必须拆分为 5 个阶段推进。

**规则：每阶段完成人工验收前，不进入下一阶段。**

---

## 10. 阶段一：数据模型与持久化闭环

### 10.1 目标

先打通：

- `Markdown 注释 <-> parser <-> TableModel <-> serializer`

这一阶段**不做任何拖拽 UI**。

### 10.2 改动范围

- `src/table/model.ts`
- `src/table/parser.ts`
- `src/table/serializer.ts`
- `src/table/ops.ts`

### 10.3 交付内容

1. `TableModel.colWidths`
2. 列宽注释解析
3. 列宽注释序列化
4. 插列/删列/移列对 `colWidths` 的同步维护

### 10.4 不做内容

1. 不改阅读视图
2. 不改 Live Preview
3. 不加拖拽
4. 不加设置项

### 10.5 人工验收标准

人工在测试文档中验证：

1. 手工写入 `<!-- tm-colwidths: 120|180|240 -->` 后，解析不报错
2. 运行任意表格编辑动作后，列宽注释不会丢失
3. 插列后注释列数同步增加
4. 删列后注释列数同步减少
5. 移列后宽度顺序同步变化
6. 非法注释不会导致表格损坏

### 10.6 通过条件

以上 6 项全部通过，才能进入阶段二。

---

## 11. 阶段二：结构行识别与编辑链路打通

### 11.1 目标

让编辑器内所有表格动作都能正确包含列宽注释所在的表格块。

### 11.2 改动范围

- `src/editor/tableLocator.ts`
- `src/editor/actions.ts`
- 必要时抽公共结构行工具文件

### 11.3 交付内容

1. `colWidths` 注释纳入结构行识别
2. `locateTable()` block 范围稳定
3. `computeCursorPos()` 跳过列宽注释
4. 表格动作后光标恢复正确

### 11.4 人工验收标准

1. 光标在表格内任意位置执行插行/删列/排序后，列宽注释仍跟随该表
2. 光标不会跳到注释行
3. 两张相邻表格各自带注释时，不会串表
4. 带 caption + colWidths 的表格仍能正确识别
5. **历史样本规范化**：对“无 caption、带 colWidths 注释、注释与表头紧挨着（中间无空行）”的历史样本执行一次浮动工具栏插列 / 删列后，再次打开源文件，应看到注释与表头之间已**自动规范化为 1 行空行分隔**；回到 Live Preview 视图，表格能正常渲染为表格（不再回退为源码文本）

### 11.5 通过条件

以上 5 项全部通过，才能进入阶段三。

---

## 12. 阶段三：阅读视图渲染列宽

### 12.1 目标

让阅读视图能读取并显示持久化列宽。

### 12.2 改动范围

- `src/render/postProcessor.ts`
- `src/render/tableRenderer.ts`

### 12.3 交付内容

1. source block 收集支持 `colWidths` 注释
2. `tableRenderer` 输出 `<colgroup>`
3. `modelSignature` 纳入 `colWidths`

### 12.4 人工验收标准

1. 阅读视图中表格宽度与注释一致
2. 仅修改列宽时，阅读视图刷新后能生效
3. 多张表格不会错配宽度
4. 无 `colWidths` 的旧表格显示不受影响

### 12.5 通过条件

以上 4 项全部通过，才能进入阶段四。

---

## 13. 阶段四：网格编辑器拖拽列宽

### 13.1 目标

先在低风险的网格编辑器里提供完整拖拽体验。

### 13.2 改动范围

- `src/ui/gridEditorModal.ts`
- `styles.css`

### 13.3 交付内容

1. 表头拖拽手柄
2. 拖拽更新 `model.colWidths`
3. 应用按钮回写 Markdown
4. 插删移列后网格列宽状态正确

### 13.4 人工验收标准

1. 网格编辑器中可稳定拖动列宽
2. 拖动结束点击“应用”后，Markdown 写入列宽注释
3. 重新打开网格编辑器时，列宽能正确恢复
4. 合并单元格存在时，列宽拖拽不崩溃
5. 插列/删列后拖拽仍可继续使用
6. **空行规则写入校验**：对一张“无 caption”的表在网格编辑器里拖完列宽后点“应用”，查看源文件应满足：
   - 有 `<!-- tm-colwidths: ... -->` 注释；
   - 注释与下一行 `| 表头 |` / separator 之间**恰好空 1 行**；
   - Live Preview 视图下该表能正常渲染为表格，不会退化为源码文本。

### 13.5 通过条件

以上 6 项全部通过，才能进入阶段五。

---

## 14. 阶段五：Live Preview 拖拽列宽

### 14.1 目标

在不破坏现有 widget 稳定性的前提下，为 Live Preview 增加拖拽入口。

### 14.2 改动范围

- `src/render/livePreview.ts`
- 如有必要新增 `src/render/colWidthOverlay.ts`
- `styles.css`
- `src/main.ts`

### 14.3 实施约束

必须遵守：

1. 手柄采用 overlay 方案
2. 拖拽过程中不重建 table DOM
3. 回写动作在拖拽结束后统一触发
4. 若验证发现 widget 稳定性差，则阶段五可以拆成 5A“只显示宽度、不支持拖拽”和 5B“启用拖拽”

### 14.4 人工验收标准

1. Live Preview 中可拖拽列宽
2. 拖拽后不会退化成源码文本
3. 滚动、切换 tab、切换 leaf 后 overlay 不错位
4. 回写后阅读视图和网格编辑器宽度一致
5. 长表格、多张表、合并单元格场景稳定

### 14.5 通过条件

以上 5 项全部通过，阶段五才算完成。

---

## 15. 推荐开发顺序

严格按以下顺序执行：

1. 阶段一：数据闭环
2. 阶段二：编辑链路
3. 阶段三：阅读视图
4. 阶段四：网格编辑器拖拽
5. 阶段五：Live Preview 拖拽

不建议跳过前置阶段直接做交互。

---

## 16. 测试矩阵

每阶段开发都建议覆盖以下测试场景：

### 16.1 基础表格

1. 3 列普通表格
2. 10 列宽表格
3. 中文内容表格

### 16.2 扩展能力

1. 带 caption
2. 多行表头
3. 多个 tbody
4. 合并单元格
5. 多行单元格

### 16.3 编辑动作组合

1. 先拖宽，再插列
2. 先拖宽，再删列
3. 先拖宽，再移列
4. 先拖宽，再排序
5. 先拖宽，再打开网格编辑器修改内容

### 16.4 视图一致性

1. Markdown 源码
2. Live Preview
3. 阅读视图
4. 网格编辑器

---

## 17. 风险清单

### 风险 1：结构行识别分叉

如果 `tableLocator`、`postProcessor`、`livePreview` 三处各写一套正则，后续极易漂移。

应对：

1. 抽公共结构行判定函数
2. 所有模块统一复用

### 风险 2：列宽数组与列数失配

应对：

1. 所有列操作都维护 `colWidths`
2. 渲染前做长度校验
3. 非法则回退自动宽度

### 风险 3：Live Preview 退化

应对：

1. 先做网格编辑器拖拽
2. Live Preview 采用 overlay
3. 必要时拆成 5A/5B 两阶段

### 风险 4：历史表格兼容

应对：

1. 无注释的表格完全兼容旧逻辑
2. 新增字段全部可选

---

## 18. 最终实施约束

后续 AI 或人工开发必须遵守：

1. 每次只实现当前阶段内容，不得顺手带入下一阶段功能。
2. 每次提交前必须对照本阶段“人工验收标准”自检。
3. 如果某阶段验收不过，先修正当前阶段，不得绕过。
4. 如果 Live Preview 拖拽实现影响稳定性，允许降级为“仅显示持久化宽度，不支持拖拽”，并重新评估阶段五。

---

## 19. 结论

本功能可以实现，但它不是一个单点 UI 功能，而是一条跨越：

- 表格块识别
- 解析
- 数据模型
- 列操作
- 序列化
- 阅读视图渲染
- Live Preview 渲染
- 网格编辑器交互

的完整链路能力。

因此本方案明确要求：

1. 先打通数据与持久化闭环
2. 再打通编辑链路与渲染
3. 最后再上拖拽交互

只有这样，后续 AI 才能稳定地按文档逐步设计和开发，而不会把列宽功能做成一次性的局部补丁。
