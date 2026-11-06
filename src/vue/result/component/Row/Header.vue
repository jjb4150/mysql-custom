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
/* ===== 表头单元：左对齐、两行紧凑排布 ===== */
.field-header {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 2px;
  line-height: 1.3;
  padding: 2px 4px;
  overflow: hidden;
  width: 100%;
  text-align: left;
}

.field-header__name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}

/* 字段名：主信息，加粗但不过重 */
.field-header__name {
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  color: var(--vscode-foreground);
  user-select: text;
  cursor: text;
}

/* 必填标记：紧贴字段名的小圆点，不再用飘着的红星 */
.field-header__required {
  flex: none;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #f56c6c;
  opacity: 0.9;
  margin-right: 1px;
}

/* 主键标记：柔和胶囊，去掉硬边框 */
.field-header__pk {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.4px;
  color: #409eff;
  background: rgba(64, 158, 255, 0.14);
  border-radius: 3px;
  padding: 1px 4px;
  line-height: 1.2;
}

/* 注释/类型行：提高可读性，不再灰到看不见 */
.field-header__sub {
  font-size: 11px;
  line-height: 1.2;
  opacity: 0.72;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 100%;
  color: var(--vscode-descriptionForeground, inherit);
}

/* 副标题是"类型"时更弱：类型是次要信息，不该和中文注释抢注意力 */
.field-header__sub--type {
  font-size: 10px;
  opacity: 0.45;
  font-family: var(--vscode-editor-font-family, monospace);
}

/* 列头整体选中态：与单元格选区一致的蓝调 */
.field-header--selected {
  background: rgba(64, 158, 255, 0.16);
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgba(64, 158, 255, 0.4);
}
</style>