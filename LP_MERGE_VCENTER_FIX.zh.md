# LP 纵向合并单元格垂直居中排障记录

## 问题现象

- 阅读模式下，纵向合并单元格的内容垂直居中正常。
- Live Preview 下，同一份表格的纵向合并单元格内容没有垂直居中。
- 调试过程中一度出现过“编辑时偶发重复显示两个 `2`”的现象，但后续未稳定复现。

## 结论先看

这类问题如果再次出现，优先按下面顺序排查：

1. 先确认 LP 合并锚点的 `td` 是否已经拿到了：
   - `rowspan`
   - `data-tm-merge="anchor"`
   - `data-tm-merge-axis="row"` 或 `both`
   - `vertical-align: middle !important`
2. 如果这些都已经正确，但视觉上还是不居中，不要先去怀疑 merge 映射错位。
3. 先检查 LP 单元格里的 `.table-cell-wrapper` 是否被拉成了和整个 `td` 一样高。
4. 如果 wrapper 撑满整格，高概率就是它让 `td` 的 `vertical-align` 失效了。

## 真实根因

LP 下真正承载可视文本内容的不是 `td` 本身，而是内部的：

- `.table-cell-wrapper`

另外，纵向合并单元格里通常还会有一个额外子元素：

- `.table-row-drag-handle`

其中：

- `.table-row-drag-handle` 是绝对定位的拖拽手柄，不是重复文本根因。
- 真正的问题是 `.table-cell-wrapper` 被 LP / 编辑器样式拉成了与整个合并单元格等高。

一旦 wrapper 高度和 `td` 一样高，就会出现：

- `td` 虽然已经是 `vertical-align: middle`
- 但真正显示文字的 wrapper 仍然铺满整格
- 最终视觉上看起来还是贴顶

## 这次验证过的非根因

下面这些方向这次都验证过，不是根因：

- 不是 merge 锚点打错了单元格
- 不是 `rowspan` / `colspan` 没有正确写入
- 不是 `vertical-align` 被普通 CSS 覆盖
- 不是 `.table-row-drag-handle` 本身导致文字重复

## 最终修法

最终保留的修法有两步：

1. 对 LP 下包含纵向跨度的合并锚点，继续给 `td` 写：

```ts
td.style.setProperty("vertical-align", "middle", "important");
```

2. 同时把 `.table-cell-wrapper` 的高度从“整格等高”收回到内容本身：

```ts
wrapper.style.width = "100%";
wrapper.style.setProperty("height", "auto", "important");
wrapper.style.setProperty("min-height", "0", "important");
wrapper.style.setProperty("max-height", "max-content", "important");
```

## 不推荐的中间方案

这次调试里试过两种方案，最后都没有保留：

### 1. 把 wrapper 改成 flex 垂直居中

问题：

- 容易影响原本的水平对齐表现
- 编辑态更容易出现结构干扰
- 一度和“偶发重复显示文本”的现象同时出现

### 2. 用 `top: 50% + translateY(-50%)` 硬挪 wrapper

问题：

- 当 wrapper 本身已经和整格等高时，这个方案基本等效空操作
- 不会真正解决“wrapper 撑满整格”这个根因

## 当前接受的行为

当前确认可以接受的表现：

- LP 下未编辑时：纵向合并单元格正常垂直居中
- 编辑时：文本可能临时回到顶部
- 编辑结束后：恢复垂直居中

这个现象目前作为编辑态交互取舍接受，不视为阻断性 bug。

## 再次遇到时的最短修复路径

如果以后又出现“阅读模式正常、LP 不垂直居中”的问题，建议直接这样排查：

1. 看 `src/render/livePreview.ts` 里 LP 合并锚点是否仍然给 `td` 写了 `vertical-align: middle !important`
2. 打开开发者工具，看合并格里是否存在 `.table-cell-wrapper`
3. 看它的 computed height 是否和整个 `td` 一样高
4. 如果一样高，优先修 wrapper 的高度约束，不要先上 flex / transform

## 相关代码位置

- [src/render/livePreview.ts](file:///Users/lawliet/Documents/WorkSpace/Lawliet-lian/table-master/src/render/livePreview.ts)
- [styles.css](file:///Users/lawliet/Documents/WorkSpace/Lawliet-lian/table-master/styles.css)
- [src/table/model.ts](file:///Users/lawliet/Documents/WorkSpace/Lawliet-lian/table-master/src/table/model.ts)

