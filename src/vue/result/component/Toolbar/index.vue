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
  padding: 4px 8px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
}

/* 单行布局：左侧操作区，右侧统计与分页，不再换行 */
.toolbar__row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  overflow: hidden;
  /* 统一字号，避免中文按钮被撑大 */
  font-size: 12px;
  line-height: 1;
}

/* 工具栏内所有按钮统一小巧尺寸 */
.toolbar__row .el-button--mini {
  padding: 5px 9px;
  font-size: 12px;
  line-height: 1;
  height: 24px;
  display: inline-flex;
  align-items: center;
}

.toolbar__row .el-button--mini i {
  font-size: 13px;
  margin-right: 3px;
}

/* 图标按钮不带文字时不需要额外间距 */
.toolbar__row .el-button--mini.el-button--icon-only i {
  margin-right: 0;
}

.toolbar__spacer {
  flex: 1 1 auto;
  min-width: 8px;
}

.toolbar__cost {
  font-size: 12px;
  opacity: 0.75;
  white-space: nowrap;
  flex: none;
}

.toolbar__pagesize {
  width: 100px;
  flex: none;
}

.toolbar__total {
  flex: none;
  padding: 0 4px !important;
}

.toolbar__total-count {
  font-size: 12px;
  opacity: 0.8;
  white-space: nowrap;
  flex: none;
  padding: 0 6px;
}

.toolbar__copy {
  flex: none;
  margin-left: 6px;
}

.el-button--mini.is-circle {
  padding: 6px;
}

.el-button--default {
  padding: 0;
  border: none;
  font-size: 19px;
  margin-left: 4px;
  flex: none;
}

.el-button:focus{
  color: inherit !important;
  background-color: var(--vscode-editor-background);
}

.el-button:hover {
  color: #409eff !important;
  border-color: #c6e2ff;
  background-color: var(--vscode-editor-background);
}

.el-pagination {
  padding: 0;
  flex: none;
}

>>> .el-input{
  bottom: 0;
}
>>> .el-input--mini .el-input__inner{
  height: 24px;
}
</style>

<style>
.el-pagination span,.el-pagination li,
.btn-prev i,.btn-next i{
  line-height: 27px !important;
}
</style>