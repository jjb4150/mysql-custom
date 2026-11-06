<template>
  <el-tooltip
    class="item"
    effect="dark"
    :content="getTip()"
    placement="bottom-start"
    :open-delay="700"
    :enterable="false"
  >
    <div
      class="field-header"
      :class="{ 'field-header--selected': columnSelected }"
      @dblclick.stop="onHeaderDblClick($event)"
    >
      <div class="field-header__name-row">
        <!-- 字段名本身可被单击选中、直接 Ctrl+C 复制 -->
        <span class="field-header__name" :title="name">{{ name }}</span>
        <span v-if="isPrimaryKey" class="field-header__pk">PK</span>
        <span v-if="isRequired" class="field-header__required" title="非空"></span>
      </div>
      <div v-if="subLabel"
        class="field-header__sub"
        :class="{ 'field-header__sub--type': !subIsComment }"
        :title="subLabel">{{ subLabel }}</div>
    </div>
  </el-tooltip>
</template>

<script>
export default {
  props: ["scope", "result", "index", "columnSelected"],
  data() {
    return {
      clickTimer: null,
    };
  },
  beforeDestroy() {
    if (this.clickTimer) clearTimeout(this.clickTimer);
  },
  methods: {
    /**
     * 单击字段名：只选中文字（浏览器原生），
     * 用户可以自己 Ctrl+C 复制，不弹窗、不做额外动作。
     */
    onHeaderClick(event) {
      // 已改由 @click 绑定在名字上，这里保留给键盘可达性
      this.$emit("selectColumn", this.name, event);
    },
    /** 双击列头：选中整列；按住 Ctrl/Shift 双击可累加到已有选区 */
    onHeaderDblClick(event) {
      // 双击时浏览器会顺带选中字段名文字，先清掉选区避免视觉混淆
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel) sel.removeAllRanges();
      } catch (e) { /* 忽略 */ }
      this.selectWholeColumn(event);
    },
    /**
     * 选中整列。
     * event 必须原样透传：父组件的 onSelectColumn 靠 event.ctrlKey/metaKey/shiftKey
     * 判断是累加还是替换，丢了 event 就只剩"替换"一种行为。
     */
    selectWholeColumn(event) {
      this.$emit("selectColumn", this.name, event || null);
    },
    getTip() {
      const meta = this.columnMeta;
      const parts = [this.name];
      if (meta) {
        if (meta.comment) parts.push(meta.comment);
        if (meta.type) parts.push(meta.type);
        if (meta.key === "PRI") parts.push("PRIMARY KEY");
        if (meta.nullable) parts.push(meta.nullable === "YES" ? "NULL" : "NOT NULL");
      }
      return parts.join("  ·  ");
    },
  },
  computed: {
    name() {
      const col = this.scope && this.scope.column;
      return (col && col.title) || "";
    },
    /**
     * 按字段名匹配列信息。不能用 index：
     * columnList 来自 information_schema（表定义顺序），fields 是 SELECT 输出顺序，
     * SELECT b, a 时会错位。
     */
    columnMeta() {
      const list = this.result.columnList || [];
      const target = this.name;
      if (!target) return null;
      return (
        list.find(
          (c) => c && c.name && String(c.name).toLowerCase() === String(target).toLowerCase()
        ) || null
      );
    },
    showComment() {
      const cfg = this.result.showColumnComment;
      return cfg === undefined ? true : cfg;
    },
    /** 副标题：有注释显示注释，否则显示类型 */
    subLabel() {
      const meta = this.columnMeta;
      if (!meta) return "";
      if (this.showComment && meta.comment) return meta.comment;
      return meta.type || "";
    },
    /** 副标题是注释还是类型（类型用更弱的样式，避免和注释抢视觉） */
    subIsComment() {
      const meta = this.columnMeta;
      return !!(meta && this.showComment && meta.comment);
    },
    isRequired() {
      const meta = this.columnMeta;
      return meta && meta.nullable && meta.nullable !== "YES";
    },
    isPrimaryKey() {
      const meta = this.columnMeta;
      return meta && meta.key === "PRI";
    },
  },
};
</script>

<style>
/* ===== 表头单元：左对齐、两行紧凑排布 =====
 * 颜色/间距统一走 tokens.css 的变量，不写死色值。
 */
.field-header {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 1px;
  line-height: 1.3;
  padding: 2px 2px;
  overflow: hidden;
  width: 100%;
  text-align: left;
  border-radius: var(--mc-radius-sm);
  transition: background var(--mc-dur) var(--mc-ease);
}

.field-header__name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}

/* 字段名：主信息，用中等字重 + 略紧的字距，比纯 bold 更清爽 */
.field-header__name {
  font-weight: 600;
  font-size: var(--mc-fs);
  letter-spacing: 0.1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  color: var(--mc-fg);
  user-select: text;
  cursor: text;
}

/* 必填标记：紧贴字段名的小圆点，不用飘着的红星 */
.field-header__required {
  flex: none;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--mc-danger);
  opacity: 0.85;
}

/* 主键标记：柔和胶囊。用强调色描边而非填充——
 * 填充在暗色主题下会盖住字段名，描边更轻。 */
.field-header__pk {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--mc-accent);
  background: transparent;
  border-radius: 3px;
  padding: 0 3px;
  line-height: 1.5;
  box-shadow: inset 0 0 0 1px var(--mc-accent);
  opacity: 0.75;
}

/* 注释/类型行：次要信息，但不能灰到看不见 */
.field-header__sub {
  font-size: var(--mc-fs-sm);
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 100%;
  color: var(--mc-fg-dim);
  opacity: 0.85;
}

/* 副标题是"类型"时更弱：类型是次要信息，不该和中文注释抢注意力 */
.field-header__sub--type {
  font-size: var(--mc-fs-xs);
  opacity: 0.55;
  font-family: var(--vscode-editor-font-family, monospace);
  letter-spacing: 0.1px;
}

/* 列头整体选中态：与单元格选区同一套色 */
.field-header--selected {
  background: var(--mc-selected);
  box-shadow: inset 0 0 0 1px var(--mc-selected-border);
}
</style>