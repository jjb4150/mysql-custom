<template>
  <div class="toolbar">
    <div class="toolbar__row">
      <el-button v-if="showFullBtn" @click="()=>$emit('sendToVscode','full')" type="primary" title="Full Result View" icon="el-icon-rank" size="mini" circle>
      </el-button>
      <el-input v-model="searchInput" size="mini" placeholder="搜索数据（高亮匹配）" style="width:200px" :clearable="true" @keyup.enter.native="searchNext" />
      <template v-if="searchInput">
        <span class="search-counter">{{ searchMatch }}</span>
        <el-button icon="el-icon-arrow-up" size="mini" title="上一项" @click="$emit('searchNav','prev')"></el-button>
        <el-button icon="el-icon-arrow-down" size="mini" title="下一项" @click="$emit('searchNav','next')"></el-button>
      </template>
      <el-button size="mini" type="primary" icon="el-icon-download" @click="$emit('export');" title="Export">Export</el-button>
      <el-button size="mini" :type="showAllMode ? 'success' : 'default'" :title="showAllMode ? '恢复分页' : '加载全部数据（不分页）'" @click="$emit('toggleShowAll')">
        {{ showAllMode ? '分页' : '全部' }}
      </el-button>
      <el-button icon="el-icon-circle-plus-outline" @click="$emit('insert')" title="插入新行"></el-button>
      <el-button icon="el-icon-delete" style="color:#f56c6c" @click="$emit('deleteConfirm');" title="删除选中行"></el-button>
      <el-button icon="el-icon-refresh-right" title="重新执行当前查询（刷新数据）" @click="$emit('run');"></el-button>
      <!-- 有未保存修改时才出现，明确告诉用户改了什么、怎么提交 -->
      <el-button v-if="dirtyCount > 0" size="mini" type="warning" icon="el-icon-check"
        :title="'保存 ' + dirtyCount + ' 行的修改（Ctrl+S）'"
        @click="$emit('saveChanges')">
        保存 ({{ dirtyCount }})
      </el-button>
      <el-button v-if="dirtyCount > 0" size="mini" icon="el-icon-close" title="放弃所有未保存的修改"
        @click="$emit('discardChanges')">
        放弃
      </el-button>

      <span class="toolbar__spacer"></span>

      <span class="toolbar__cost">Cost: {{costTime}}ms</span>
      <el-select v-if="!showAllMode" v-model="pageSizeLocal" size="mini" class="toolbar__pagesize" @change="changePageSize" title="每页行数">
        <el-option v-for="s in pageSizeOptions" :key="s" :label="s + ' 行/页'" :value="s"></el-option>
      </el-select>
      <el-pagination v-if="!showAllMode"
        @current-change="page=>$emit('changePage',page,true)"
        @next-click="()=>$emit('changePage',1)"
        @prev-click="()=>$emit('changePage',-1)"
        :current-page.sync="page.pageNum"
        :small="true"
        :page-size="page.pageSize"
        :layout="page.total!=null?'prev, pager, next, jumper, total':'prev, next'"
        :total="page.total">
      </el-pagination>
      <span v-else class="toolbar__total-count">共 {{ page.total != null ? page.total : '?' }} 行（全部加载）</span>
      <!-- 总数按需统计：点击后才向数据库发起 count，避免大表自动慢查询 -->
      <el-button v-if="page.total == null && page.totalPending" size="mini" type="text" class="toolbar__total" title="点击统计总行数" @click="$emit('requestTotal')">
        Total ?
      </el-button>
      <span v-else-if="page.total == null" class="total-unknown" title="该查询不统计总数">Total -</span>
    </div>
  </div>
</template>

<script>
export default {
  props: ["costTime", "search", "showFullBtn", "page", "searchIndex", "searchTotal", "showAllMode", "dirtyCount"],
  data() {
    return {
      searchInput: null,
      pageSizeLocal: 100,
      pageSizeOptions: [50, 100, 200, 500, 1000],
    };
  },
  computed: {
    searchMatch() {
      const total = this.searchTotal || 0;
      if (!total) return "无匹配";
      return `${(this.searchIndex || 0) + 1}/${total}`;
    },
  },
  watch: {
    "page.pageSize": {
      handler(v) {
        if (v && v > 0 && v !== this.pageSizeLocal) {
          this.pageSizeLocal = v;
        }
      },
      immediate: true,
    },
    searchInput: function () {
      this.$emit("update:search", this.searchInput); // 将子组件的输入框的值传递给父组件 父组件需要用.sync
    },
  },
  methods: {
    changePageSize(size) {
      if (!size) return;
      this.page.pageSize = size;
      this.page.pageNum = 1;
      // 不再直接调用 vscodeEvent（它只在 App.vue 里定义，子组件访问不到，
      // 之前就是这行抛 ReferenceError 导致整个切换流程中断）。
      // 统一交给父组件去发消息并重新查询。
      this.$emit("reload", size);
    },
    searchNext() {
      this.$emit("searchNav", "next");
    },
  },
};
</script>

<style scoped>
.toolbar {
  margin: 0;
  padding: var(--mc-sp-1) var(--mc-sp-2);
  border-bottom: 1px solid var(--mc-border);
  background: var(--mc-bg);
  flex: none;
}

/* 单行布局：左侧操作区，右侧统计与分页，不换行 */
.toolbar__row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  overflow: hidden;
  font-size: var(--mc-fs);
  line-height: 1;
}

/* 工具栏内所有按钮统一小巧尺寸 */
.toolbar__row ::v-deep .el-button--mini {
  padding: 5px 9px;
  font-size: var(--mc-fs);
  line-height: 1;
  height: 24px;
  display: inline-flex;
  align-items: center;
  border-radius: var(--mc-radius-sm);
  transition: background var(--mc-dur) var(--mc-ease),
              border-color var(--mc-dur) var(--mc-ease),
              color var(--mc-dur) var(--mc-ease);
}

.toolbar__row ::v-deep .el-button--mini i {
  font-size: 13px;
  margin-right: 3px;
}

.toolbar__row ::v-deep .el-button--mini.el-button--icon-only i {
  margin-right: 0;
}

.toolbar__spacer {
  flex: 1 1 auto;
  min-width: 8px;
}

.toolbar__cost {
  font-size: var(--mc-fs);
  font-variant-numeric: tabular-nums;
  color: var(--mc-fg-dim);
  white-space: nowrap;
  flex: none;
}

.toolbar__pagesize {
  width: 104px;
  flex: none;
}

.toolbar__total {
  flex: none;
  padding: 0 4px !important;
}

.toolbar__total-count {
  font-size: var(--mc-fs);
  font-variant-numeric: tabular-nums;
  color: var(--mc-fg-dim);
  white-space: nowrap;
  flex: none;
  padding: 0 6px;
}

/* 输入框高度与按钮对齐 */
.toolbar__row ::v-deep .el-input--mini .el-input__inner {
  height: 24px;
  line-height: 24px;
  border-radius: var(--mc-radius-sm);
}

.toolbar__row ::v-deep .el-pagination {
  padding: 0;
  flex: none;
}

/* 焦点：用强调色外圈，而不是改背景色。
 * 之前写成 background: var(--vscode-editor-background)（与工具栏同色），
 * 键盘导航时完全看不出焦点在哪。 */
.toolbar__row ::v-deep .el-button:focus {
  border-color: var(--mc-accent);
  color: var(--mc-fg);
  box-shadow: 0 0 0 1px var(--mc-accent);
}

/* 悬停：轻微提亮，不做成强调蓝（强调色留给主操作） */
.toolbar__row ::v-deep .el-button--default:hover {
  color: var(--mc-fg);
  border-color: var(--mc-accent);
  background: var(--mc-hover);
}
</style>

<style>
/* 分页控件：Element UI 的行高写死在 27px，会让工具栏高度不齐。
 * 这里只需要调分页自身，所以放非 scoped 里但用 .el-pagination 精确限定。 */
.el-pagination span,
.el-pagination li,
.el-pagination .btn-prev i,
.el-pagination .btn-next i {
  line-height: 24px !important;
}

.el-pagination .el-pager li {
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
}
</style>