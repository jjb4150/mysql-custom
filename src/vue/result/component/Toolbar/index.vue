<template>
  <div class="toolbar">
    <div class="toolbar__row">
      <el-button v-if="showFullBtn" @click="()=>$emit('sendToVscode','full')" type="primary" :title="$t('btn.full')" icon="el-icon-rank" size="mini" circle>
      </el-button>
      <el-input v-model="searchInput" size="mini" :placeholder="$t('search.placeholder')" style="width:200px" :clearable="true" @keyup.enter.native="searchNext" />
      <template v-if="searchInput">
        <span class="search-counter">{{ searchMatch }}</span>
        <el-button icon="el-icon-arrow-up" size="mini" :title="$t('search.prev')" @click="$emit('searchNav','prev')"></el-button>
        <el-button icon="el-icon-arrow-down" size="mini" :title="$t('search.next')" @click="$emit('searchNav','next')"></el-button>
      </template>
      <el-button size="mini" type="primary" icon="el-icon-download" @click="$emit('export');" :title="$t('btn.export')">{{ $t('btn.export') }}</el-button>
      <el-button size="mini" :type="showAllMode ? 'success' : 'default'" :title="showAllMode ? $t('btn.restorePage') : $t('btn.loadAll')" @click="$emit('toggleShowAll')">
        {{ showAllMode ? $t('btn.page') : $t('btn.all') }}
      </el-button>
      <el-button icon="el-icon-circle-plus-outline" @click="$emit('insert')" :title="$t('btn.insert')"></el-button>
      <el-button icon="el-icon-delete" class="toolbar__danger" @click="$emit('deleteConfirm');" :title="$t('btn.delete')"></el-button>
      <el-button icon="el-icon-refresh-right" :title="$t('btn.refresh')" @click="$emit('run');"></el-button>
      <!-- 有未保存修改时才出现，明确告诉用户改了什么、怎么提交 -->
      <el-button v-if="dirtyCount > 0" size="mini" type="warning" icon="el-icon-check"
        :title="$t('btn.saveTitle', { n: dirtyCount })"
        @click="$emit('saveChanges')">
        {{ $t('btn.save') }} ({{ dirtyCount }})
      </el-button>
      <el-button v-if="dirtyCount > 0" size="mini" icon="el-icon-close" :title="$t('btn.discardTitle')"
        @click="$emit('discardChanges')">
        {{ $t('btn.discard') }}
      </el-button>

      <span class="toolbar__spacer"></span>

      <span class="toolbar__cost">{{ $t('cost', { ms: costTime }) }}</span>
      <el-select v-if="!showAllMode" v-model="pageSizeLocal" size="mini" class="toolbar__pagesize" @change="changePageSize" :title="$t('rowsPerPage')">
        <el-option v-for="s in pageSizeOptions" :key="s" :label="$t('pageSize', { n: s })" :value="s"></el-option>
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
      <span v-else class="toolbar__total-count">{{ $t('total.count', { n: page.total != null ? page.total : '?' }) }}</span>
      <!-- 总数按需统计：点击后才向数据库发起 count，避免大表自动慢查询 -->
      <el-button v-if="page.total == null && page.totalPending" size="mini" type="text" class="toolbar__total" :title="$t('total.requestTitle')" @click="$emit('requestTotal')">
        {{ $t('total.request') }}
      </el-button>
      <span v-else-if="page.total == null" class="total-unknown" :title="$t('total.unknownTitle')">{{ $t('total.unknown') }}</span>
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
      if (!total) return this.$t("search.noMatch");
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
  /* 不用 gap：Element 的 .el-button 自带 margin-left，
     两者叠加会让按钮间距翻倍（截图里按钮之间空得能塞下人）。
     间距统一交给下面的 margin-left 覆盖控制。 */
  gap: 0;
  flex-wrap: nowrap;
  overflow: hidden;
  font-size: var(--mc-fs);
  line-height: 1;
}

/* 工具栏内所有按钮统一小巧尺寸。
 * 用 ::v-deep 精确限定在 .toolbar__row 内，不再靠「scoped 里不写深度选择器
 * 从而泄漏成全局规则」的旧 hack —— 那种写法会连带影响结果页之外所有按钮。 */
.toolbar__row ::v-deep .el-button {
  padding: 5px 9px;
  font-size: var(--mc-fs);
  line-height: 1;
  height: 24px;
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--mc-radius-sm);
  /* Element 默认 margin-left 会让按钮与前面的元素之间出现一个不规则大缝，
     工具栏已自行排布间距，这里统一成 6px。 */
  margin-left: 6px;
  transition: background var(--mc-dur) var(--mc-ease),
              border-color var(--mc-dur) var(--mc-ease),
              color var(--mc-dur) var(--mc-ease);
}

/* Element 自带的 .el-button+.el-button 会再加 margin-left:10px，
 * 与上面的 6px 冲突，导致相邻按钮间距忽大忽小，这里一并压掉。 */
.toolbar__row ::v-deep .el-button + .el-button {
  margin-left: 6px;
}

/* 第一个按钮不要左边距 */
.toolbar__row ::v-deep .el-button:first-child {
  margin-left: 0;
}

/* 纯图标按钮：方形、无边框、透明底。
 * 原来靠全局泄漏的 .el-button--default{padding:0;border:none;font-size:19px}
 * 实现，那条规则同时污染了结果页之外所有默认按钮；这里改成精确版本。 */
.toolbar__row ::v-deep .el-button--default {
  width: 26px;
  padding: 0;
  border: 1px solid transparent;
  background: transparent;
  color: var(--mc-fg);
  font-size: 15px;
}

.toolbar__row ::v-deep .el-button--default:hover {
  color: var(--mc-fg);
  border-color: var(--mc-accent);
  background: var(--mc-hover);
}

.toolbar__row ::v-deep .el-button--mini i {
  font-size: 13px;
  margin-right: 3px;
}

.toolbar__row ::v-deep .el-button--mini.el-button--icon-only i,
.toolbar__row ::v-deep .el-button--default i {
  margin-right: 0;
  font-size: 15px;
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

/* 删除按钮：悬停才显红，平时保持中性，避免整条工具栏到处是警示色 */
.toolbar__row ::v-deep .toolbar__danger {
  color: var(--mc-fg);
}

.toolbar__row ::v-deep .toolbar__danger:hover {
  color: var(--mc-danger);
  border-color: var(--mc-danger);
  background: var(--mc-danger-bg);
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