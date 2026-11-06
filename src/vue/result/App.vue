<template>
  <div id="app">
    <div class="hint">
      <Toolbar :page="page" :showFullBtn="showFullBtn" :search.sync="table.search" :searchIndex="searchIndex" :searchTotal="searchMatches.length" :showAllMode="showAllMode" :dirtyCount="dirtyCount" :costTime="result.costTime" @changePage="changePage" @sendToVscode="sendToVscode" @export="exportOption.visible = true" @insert="$refs.editor.openInsert()" @deleteConfirm="deleteConfirm" @searchNav="navigateSearch" @requestTotal="count()" @copyAction="handleCopyAction" @toggleShowAll="toggleShowAll" @reload="reloadWithPageSize" @saveChanges="save()" @discardChanges="discardChanges" @run="info.message = false;execute(result.sql);" />
      <div v-if="info.message">
        <div v-if="info.error" class="info-panel info-panel--error">
          <span class="info-panel__text">{{ info.message }}</span>
          <span v-if="info.line != null" class="info-panel__jump" @click="jumpToError">{{ $t('error.jump') }}</span>
          <span class="info-panel__close" @click="info.message = null">×</span>
        </div>
        <div v-else class="info-panel info-panel--ok">{{ info.message }}</div>
      </div>
    </div>
    <!-- 结果 tab：一次查询一个 tab，可切换、可关闭，类似 Navicat -->
    <div class="result-tabs" v-if="resultTabs.length > 0">
      <div
        v-for="(tab, i) in resultTabs"
        :key="tab.id"
        class="result-tab"
        :class="{ 'result-tab--active': i === activeTabIndex }"
        @click="switchTab(i)"
        @mousedown.middle.prevent="closeTabByMiddle(i)"
        @auxclick.middle.prevent="closeTabByMiddle(i)"
      >
        <span class="result-tab__label">{{ tab.title }}</span>
        <span class="result-tab__count" v-if="tab.result && tab.result.data">{{ dataRowCount(tab.result) }}</span>
        <span class="result-tab__close" @click.stop="closeTab(i)">×</span>
      </div>
      <div class="result-tab result-tab--clear" v-if="resultTabs.length > 1" @click="closeAllTabs">{{ $t('tab.clear') }}</div>
</div>
    <!-- 表格区域：flex 自动撑满剩余高度 -->
    <div class="table-wrap">
      <ux-grid ref="dataTable" :data="filterData" v-loading='table.loading' size='small' :row-height="30" :excess-rows="20" :row-style="{height: '30px'}" :header-cell-style="{height: 'auto', padding: '4px 0'}" @sort-change="sort" :height="remainHeight" stripe :checkboxConfig="{ checkMethod: selectable}">
      <ux-table-column type="checkbox" width="40" fixed="left"></ux-table-column>
      <ux-table-column type="index" width="40" :seq-method="({row,rowIndex})=>(rowIndex||!row.isFilter)?rowIndex:undefined">
        <Controller slot="header" :result="result" :toolbar="toolbar" />
      </ux-table-column>
      <ux-table-column v-for="(field,index) in (result.fields||[]).filter(field=>toolbar.showColumns.includes(field.name.toLowerCase()))" :key="index" :resizable="true" :field="field.name" :title="field.name" :sortable="true" :width="computeWidth(field,0)" edit-render>
        <Header slot="header" slot-scope="scope" :result="result" :scope="scope" :index="index" :columnSelected="isColumnSelected(field.name)" @selectColumn="onSelectColumn" />
        <Row slot-scope="scope" :scope="scope" :result="result" :filterObj="toolbar.filter" :searchKeyword="table.search" :editingKey="editingKey" :selection="selectionSnapshot" :editList.sync="update.editList" @startEdit="onStartEdit" @selectCell="onCellMouseDown" @enterCell="onCellMouseEnter" @execute="execute" @sendToVscode="sendToVscode" @openEditor="openEditor" @copyRow="copyRow" @copyColumn="copyColumn" @openViewer="openViewer" />
      </ux-table-column>
      </ux-grid>
    </div>
    <EditDialog ref="editor" :dbType="result.dbType" :result="result" :database="result.database" :table="result.table" :primaryKey="result.primaryKey" :primaryKeyList="result.primaryKeyList" :columnList="result.columnList" @execute="execute" />
    <ExportDialog :visible.sync="exportOption.visible" @exportHandle="confirmExport" />
    <CellViewer
      :visible.sync="viewer.visible"
      :content="viewer.content"
      :fieldName="viewer.fieldName"
      :fieldType="viewer.fieldType"
      @copy="writeClipboard"
    />
  </div>
</template>

<script>
import { getVscodeEvent } from "../util/vscode";
import Row from "./component/Row";
import Controller from "./component/Row/Controller.vue";
import Header from "./component/Row/Header.vue";
import ExportDialog from "./component/ExportDialog.vue";
import CellViewer from "./component/CellViewer.vue";
import Toolbar from "./component/Toolbar";
import EditDialog from "./component/EditDialog";
import { util } from "./mixin/util";
import { wrapByDb } from "@/common/wrapper";
let vscodeEvent;

export default {
  mixins: [util],
  components: {
    ExportDialog,
    CellViewer,
    EditDialog,
    Toolbar,
    Controller,
    Row,
    Header,
  },
  watch: {
    // tab 栏出现/消失、结果变化时都重算，避免表格被压扁或留白
    resultTabs() {
      this.recalcHeight();
    },
    "info.message"() {
      this.recalcHeight();
    },
    // 搜索词变化后回到第一个命中
    "table.search"() {
      this.searchIndex = 0;
    },
    // 编辑内容变化时更新"未保存行数"，用于工具栏提示与保存按钮
    "update.editList": {
      handler(v) {
        try {
          const keys = Object.keys(v || {}).filter((k) => v[k]);
          this.dirtyCount = keys.length;
        } catch (e) {
          this.dirtyCount = 0;
        }
      },
      deep: true,
    },
  },
  data() {
    return {
      showFullBtn: false,
      remainHeight: 0,
      connection: {},
      /** 结果 tab 列表，每个 tab 保存自己那份 result 快照 */
      resultTabs: [],
      activeTabIndex: 0,
      tabSeq: 0,
      /** 搜索命中位置（行索引 + 列名），用于上一项/下一项 */
      searchIndex: 0,
      /** 当前正在编辑的单元格（行索引|列名），空表示没有任何单元格在编辑 */
      editingKey: "",
      /**
       * Excel 式选区：记录锚点与终点（数据行下标 + 列名）。
       * 单选格时 anchor === focus；拖拽或 Shift+点击时两者不同。
       */
      selection: {
        anchorRow: -1,
        anchorCol: "",
        focusRow: -1,
        focusCol: "",
        /** 是否点击在列头上（整列选择） */
        byColumn: false,
        /** Ctrl 多选列：离散列名集合，不含中间未点的列 */
        selectedCols: [],
        dragging: false,
        /**
         * Ctrl 多选产生的额外区域（与主选区并存）。
         * 每项：{ minRow, maxRow, cols: [列名] }
         */
        extras: [],
      },
      /** 是否处于“显示全部数据”模式（不分页） */
      showAllMode: false,
      /** 进入全量模式前的原始 SQL，退出时用它恢复 */
      originalSql: "",
      result: {
        data: [],
        dbType: "",
        costTime: 0,
        sql: "",
        primaryKey: null,
        columnList: null,
        primaryKeyList: null,
        database: null,
        table: null,
        tableCount: null,
      },
      page: {
        pageNum: 1,
        pageSize: -1,
        total: null,
        /** 总数待统计（用户可点击触发） */
        totalPending: false,
        totalUnknown: false,
      },
      /** 是否在每次查询后自动统计总数，默认关闭以免打慢查询 */
      autoCount: false,
      /** 当前这一轮执行包含几条语句（>1 表示批量执行） */
      batchSize: 1,
      table: {
        search: "",
        loading: true,
        widthItem: {},
      },
      toolbar: {
        sql: null,
        // using to clear filter input value
        filter: {},
        showColumns: [],
      },
      exportOption: {
        visible: false,
      },
      info: {
        sql: null,
        message: null,
        error: false,
        needRefresh: true,
        /** 出错语句在源编辑器中的起始行（0 基），无源编辑器时为 null */
        line: null,
      },
      update: {
        editList: {},
        lock: false,
      },
      /** 有多少行存在未保存的修改 */
      dirtyCount: 0,
      /** 长内容查看弹窗 */
      viewer: {
        visible: false,
        content: "",
        fieldName: "",
        fieldType: "",
      },
    };
  },
  mounted() {
    // 非响应式计时器，挂在实例上即可（放进 data 会被 Vue 劫持，纯属浪费）
    this.searchTimer = null;
    this.highlightTimer = null;
    this.lastMiddleCloseAt = 0;
    this.lastMiddleCloseIndex = -1;
    this.recalcHeight();
    this.showFullBtn = window.outerWidth / window.innerWidth >= 2;
    window.addEventListener("resize", () => {
      this.recalcHeight();
      this.showFullBtn = window.outerWidth / window.innerWidth >= 2;
    });
    // 点击表格空白区域时退出编辑态，方便回到"可框选"状态
    document.addEventListener("mousedown", (e) => {
      if (!this.editingKey) return;
      const t = e.target;
      // 交互元素（查看器加号、右键菜单等）单独处理，不参与编辑态判定
      if (t && t.closest && t.closest(".cell-expand")) return;
      // 点在自己正在编辑的单元格内（含内层子节点）不能退出编辑，
      // 否则无法在文本里定位光标、圈选内容。
      // 注意必须用 closest：编辑态文字是文本节点/子元素，
      // 直接判断 classList.contains 会因为 target 不是 .edit-column 本身而误判。
      if (t && t.closest && t.closest(".edit-column.is-editing")) return;
      this.endEdit();
    });
    // 全局松开鼠标：结束拖拽选区
    document.addEventListener("mouseup", () => {
      this.selection.dragging = false;
    });
    const handlerData = (data, sameTable) => {
      this.result = data;
      this.toolbar.sql = data.sql;
      // 成功拿到数据就别再挂着上一条语句的错误提示了
      this.info.message = null;
      this.info.error = false;
      this.info.line = null;

      if (sameTable) {
        this.clear();
      } else {
        this.reset();
      }
      // 先同步配置，再决定是否自动统计
      if (data.autoCountTotal != null) {
        this.autoCount = data.autoCountTotal;
      }
      // only es have.
      if (data.total != null) {
        this.page.total = parseInt(data.total);
      } else if (this.autoCount && this.result.tableCount == 1) {
        // 开启自动统计时（默认关闭）才在每次查询后跑一次 count
        this.count();
      } else {
        // 默认不自动统计：大表 count 代价高，改为用户点 Total 时才查
        this.page.total = null;
        this.page.totalPending = this.result.tableCount == 1;
      }
      this.update.editList = [];
      this.update.lock = false;

      // 多条语句执行时，后端会连续推多个 DATA。
      // 这里必须绑定本次的 result 引用，不能在回调里读 this.result ——
      // 下一个 DATA 到达时 this.result 已被替换，会登记成重复的错误 tab。
      const current = this.result;
      this.$nextTick(() => {
        this.pushResultTab(current);
        // 只有当前展示的确实是这条结果时才刷新高度，
        // 否则多条结果连续到达时高度会按最后一条反复跳
        if (this.result === current) {
          this.recalcHeight();
        }
      });
    };
    const handlerCommon = (res) => {
      if (this.$refs.editor) {
        this.$refs.editor.close();
      }
      this.info.message = res.message;
      this.info.line = res.line;
    };
    vscodeEvent = getVscodeEvent();

    vscodeEvent.on("updateSuccess", () => {
      // 用数据行序号回写，避免过滤行造成的坐标偏移
      const rows = this.dataRows();
      for (const index in this.update.editList) {
        const element = this.update.editList[index];
        const source = rows[index];
        if (source) {
          Object.assign(source, element);
        }
      }
      this.update.editList = [];
      this.update.lock = false;
      this.dirtyCount = 0;
      this.$message({
        showClose: true,
        duration: 800,
        message: this.$t("status.updated"),
        type: "success",
      });
    });
    window.onkeydown = (e) => {
      // Esc：优先退出编辑，其次清空选区
      if (e.code === "Escape") {
        if (this.editingKey) { this.endEdit(); e.preventDefault(); return; }
        if (this.hasSelection()) { this.clearSelection(); e.preventDefault(); return; }
      }

      const target = e.target;
      const inEditor = target && (
        target.classList?.contains("edit-column") && this.editingKey ||
        target.classList?.contains("edit-filter") ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA"
      );

      // Ctrl/Cmd + C：有选区时复制选区（Excel 习惯），否则交给浏览器
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyC" && !inEditor) {
        // 用户手动选中了文字（比如单击选中了字段名）时，
        // 不要拦截，交给浏览器原生复制。
        const sel = window.getSelection && window.getSelection();
        const hasTextSelection = sel && sel.toString().trim().length > 0;
        if (hasTextSelection) { return; }
        if (this.hasSelection()) {
          this.copySelection(false);
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      // Ctrl/Cmd + A：全选整个数据区
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyA" && !inEditor) {
        this.selectAll();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Ctrl/Cmd + Shift + C：复制选区（含表头）
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyC" && !inEditor) {
        this.copySelection(true);
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Enter / Tab 在编辑完成后退出编辑态
      if ((e.code === "Enter" || e.code === "Tab") && this.editingKey
        && target && target.classList && target.classList.contains("edit-column")) {
        this.endEdit();
      }

      // Ctrl/Cmd + Alt + C：复制整个表格（含表头）
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === "KeyC" && !inEditor) {
        this.copyAll(true);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    };
    window.onkeypress = (e) => {
      if (
        (e.code == "Enter" && e.target.classList.contains("edit-column")) ||
        (e.ctrlKey && e.code == "KeyS")
      ) {
        this.save();
        e.stopPropagation();
        e.preventDefault();
      }
    };
    window.addEventListener("message", ({ data }) => {
      if (!data) return;
      const response = data.content;
      console.log(data);
      this.result.transId=response.transId;
      this.table.loading = false;
      switch (data.type) {
        case "EXPORT_DONE":
          this.exportOption.visible = false;
          break;
        case "RUN":
          this.toolbar.sql = response.sql;
          // 记录本轮语句条数：批量执行时禁止 DML 触发 refresh()，
          // 否则会重跑当前 result.sql 造成重复执行
          this.batchSize = response.batchSize || 1;
          this.table.loading = response.transId != this.result.transId;
          break;
        case "DATA":
          handlerData(response);
          break;
        case "NEXT_PAGE":
          this.result.data = response.data;
          this.result.costTime=response.costTime;
          // 后端返回的是本次真正执行的 SQL（含新的 LIMIT），
          // 必须同步回 result.sql，否则下次翻页/改页大小仍基于旧 LIMIT 计算。
          this.result.sql = response.sql;
          this.toolbar.sql = response.sql;
          // 如果后端带了 pageSize 就同步（切页大小后能立刻反映）
          if (response.pageSize) {
            this.page.pageSize = response.pageSize;
          }
          this.result.data.unshift({ isFilter: true, content: "" });
          // 翻页后必须重置表格内部状态：
          // 虚拟滚动会保留上一页的滚动位置与行高缓存，
          // 从空页翻回有数据的页时会出现白屏，要滚动或等一会才渲染。
          this.$nextTick(() => {
            this.resetGridAfterPageChange();
          });
          break;
        case "COUNT":
          // 复杂查询或超时时后端会给 null，此时不显示总数，而不是显示 NaN
          if (response.data == null || response.data === "") {
            this.page.total = null;
            this.page.totalUnknown = true;
          } else {
            this.page.total = parseInt(response.data);
            this.page.totalUnknown = false;
          }
          break;
        case "DML":
        case "DDL":
        case "MESSAGE_BLOCK":
          handlerCommon(response);
          this.info.error = false;
          this.info.needRefresh = false;
          // 只有真正影响数据的语句才需要刷新表数据。
          // 原来靠 message 里含 "AffectedRows" 判断，现在该文案不再拼进 message，
          // 改成看后端给的结构化字段，避免 message 为 null 时抛异常。
          //
          // 批量执行时绝对不能 refresh：refresh() 会重跑当前 result.sql，
          // 而此刻 result 可能还停留在批次里的另一条语句，会造成重复执行 + tab 错乱。
          if ((response.affectedRows || response.isInsert) && this.batchSize <= 1) {
            this.refresh();
          }
          break;
        case "ERROR":
          handlerCommon(response);
          this.info.error = true;
          break;
        case "MESSAGE":
          if (response.message) {
            this.$message({
              showClose: true,
              duration: 1000,
              message: response.message,
              type: response.success ? "success" : "error",
            });
          }
          this.refresh();
          break;
      }
    });
    vscodeEvent.emit("init");
    window.addEventListener("keyup", (event) => {
      if (event.key == "c" && event.ctrlKey) {
        document.execCommand("copy");
      }
    });
  },
  methods: {
    panelInput(event){
      if(event.code=='Enter' && event.ctrlKey){
        this.execute(this.toolbar.sql)
        event.stopPropagation()
      }
    },
    selectable({row}) {
      return this.editable && !row.isFilter;
    },
    save() {
      if (Object.keys(this.update.editList).length == 0 && this.update.lock) {
        return;
      }
      this.update.lock = true;
      // editList 的 key 是「数据行序号」（不含过滤占位行），
      // 而 result.data 里含过滤行，必须用它转换后再取原始行，
      // 否则 WHERE 条件会指向错误的记录（改错数据）。
      const rows = this.dataRows();
      let sql = "";
      for (const index in this.update.editList) {
        const element = this.update.editList[index];
        const originRow = rows[index];
        if (!originRow) continue;
        sql += this.$refs.editor.buildUpdateSql(element, originRow);
      }
      if (sql) {
        vscodeEvent.emit("saveModify", sql);
      }
    },
    /** 放弃所有未保存修改：重新拉取当前页数据 */
    discardChanges() {
      this.update.editList = [];
      this.update.lock = false;
      this.dirtyCount = 0;
      this.execute(this.result.sql);
    },
    sendToVscode(event, param) {
      vscodeEvent.emit(event, param);
    },
    openEditor(row, isCopy) {
      if (isCopy) {
        this.$refs.editor.openCopy(row);
      } else {
        this.$refs.editor.openEdit(row);
      }
    },
    confirmExport(exportOption) {
      vscodeEvent.emit("export", {
        option: {
          ...exportOption,
          sql: this.result.sql,
          table: this.result.table,
        },
      });
    },
    sort(row) {
      if (this.result.dbType == "ElasticSearch") {
        vscodeEvent.emit("esSort", [{ [row.prop]: { order: row.order } }]);
        return;
      }
      let sortSql = this.result.sql
        .replace(/\n/, " ")
        .replace(";", "")
        .replace(/order by .+? (desc|asc)?/gi, "")
        .replace(/\s?(limit.+)?$/i, ` ORDER BY ${row.prop} ${row.order} \$1 `);
      this.execute(sortSql + ";");
    },
    getTypeByColumn(key) {
      if (!this.result.columnList) return;
      for (const column of this.result.columnList) {
        if (column.name === key) {
          return column.simpleType || column.type;
        }
      }
    },
    deleteConfirm() {
      const datas = this.$refs.dataTable.getCheckboxRecords();
      if (!datas || datas.length == 0) {
        this.$message({
          type: "warning",
          message: "You need to select at least one row of data.",
        });
        return;
      }
      this.$confirm("Are you sure you want to delete this data?", "Warning", {
        confirmButtonText: "OK",
        cancelButtonText: "Cancel",
        type: "warning",
      })
        .then(() => {
          let checkboxRecords = datas
            .filter(
              (checkboxRecord) => checkboxRecord[this.result.primaryKey] != null
            )
            .map((checkboxRecord) =>
              this.wrapQuote(
                this.getTypeByColumn(this.result.primaryKey),
                checkboxRecord[this.result.primaryKey]
              )
            );
          let deleteSql = null;
          if (this.result.dbType == "ElasticSearch") {
            deleteSql =
              checkboxRecords.length > 1
                ? `POST /_bulk\n${checkboxRecords
                    .map(
                      (c) =>
                        `{ "delete" : { "_index" : "${this.result.table}", "_id" : "${c}" } }`
                    )
                    .join("\n")}`
                : `DELETE /${this.result.table}/_doc/${checkboxRecords[0]}`;
          } else if (this.result.dbType == "MongoDB") {
            deleteSql = `db('${this.result.database}').collection("${
              this.result.table
            }")
              .deleteMany({_id:{$in:[${checkboxRecords.join(",")}]}})`;
          } else {
            const table=wrapByDb(this.result.table,this.result.dbType);
            deleteSql =
              checkboxRecords.length > 1
                ? `DELETE FROM ${table} WHERE ${this.result.primaryKey} in (${checkboxRecords.join(",")})`
                : `DELETE FROM ${table} WHERE ${this.result.primaryKey}=${checkboxRecords[0]}`;
          }
          this.execute(deleteSql);
        })
        .catch((e) => {
          if (e) {
            this.$message.error(e);
          } else {
            this.$message({ type: "warning", message: "Delete canceled" });
          }
        });
    },
    /**
     * compute column row width, get maxium of fieldName or value or fieldType by top 10 row.
     */
    computeWidth(field, index) {
      // only compute once.
      let key = field.name;
      if (this.table.widthItem[key]) return this.table.widthItem[key];
      if (!index) index = 0;

      // 表头第二行（注释/类型）也要参与宽度计算，否则注释被省略号截断
      const meta = (this.result.columnList || []).find(
        (c) => c && c.name && String(c.name).toLowerCase() === String(field.name).toLowerCase()
      );
      const subText = (meta && (meta.comment || meta.type)) || "";
      // 中文按 2 个字符宽度估算
      const textWidth = (text) =>
        String(text || "").replace(/[^\x00-\xff]/g, "aa").length;

      let maxText = Math.max(
        textWidth(key),
        textWidth(subText),
        textWidth(field.type)
      );

      // 扫描前 10 行取数据宽度
      for (let i = 0; i < 10 && this.result.data[i]; i++) {
        maxText = Math.max(maxText, textWidth(this.result.data[i][key]));
      }

      // 7px/字符 + 内边距；长注释给足空间，避免被省略号截成半句
      let width = maxText * 7 + 24;
      if (width > 340) width = 340;
      if (width < 90) width = 90;

      this.table.widthItem[key] = width;
      return width;
    },
    refresh() {
      if (this.result.sql) {
        this.execute(this.result.sql);
      }
    },
    /** 从结果面板跳回 SQL 编辑器的出错行 */
    jumpToError() {
      if (this.info.line == null) { return; }
      vscodeEvent.emit("jumpToLine", { line: this.info.line });
    },
    count() {
      if (!this.result.table) return;
      this.info.message = null;
      vscodeEvent.emit("count", { sql: this.result.sql });
    },
    execute(sql, noAutoPaging) {
      if (!sql) return;
      vscodeEvent.emit("execute", {
        sql,
        noAutoPaging: !!noAutoPaging,
      });
      this.table.loading = true;
    },
    changePage(pageNum, jump) {
      let target = jump ? pageNum : this.page.pageNum + pageNum;
      // 已知总数时限制页码范围，避免翻到必然为空的页
      if (this.page.total != null && this.page.pageSize > 0) {
        const maxPage = Math.max(Math.ceil(this.page.total / this.page.pageSize), 1);
        if (target < 1) { target = 1; }
        if (target > maxPage) { target = maxPage; }
      } else if (target < 1) {
        target = 1;
      }
      if (target === this.page.pageNum && jump) { return; }
      this.page.pageNum = target;
      vscodeEvent.emit("next", {
        sql: this.result.sql,
        pageNum: target,
        pageSize: this.page.pageSize,
      });
      this.table.loading = true;
    },

    initShowColumn() {
      const fields = this.result.fields;
      if (!fields) return;
      this.toolbar.showColumns = [];
      for (let i = 0; i < fields.length; i++) {
        if (!fields[i].name) continue;
        this.toolbar.showColumns.push(fields[i].name.toLowerCase());
      }
    },
    // show call when load same table data
    /** 列出所有命中位置，供上一项/下一项跳转 */
    computeSearchMatches() {
      const keyword = (this.table.search || "").toLowerCase();
      if (!keyword) return [];
      const matches = [];
      const columns = this.visibleColumns();
      const data = this.result.data || [];
      // dataIndex 指向 data 中的真实下标（跳过过滤行），供滚动定位使用
      let dataIndex = 0;
      data.forEach((row) => {
        if (!row || row.isFilter) return;
        columns.forEach((col) => {
          const raw = row[col];
          if (raw == null) return;
          if (String(raw).toLowerCase().indexOf(keyword) >= 0) {
            matches.push({ dataIndex, column: col });
          }
        });
        dataIndex++;
      });
      return matches;
    },
    /** 当前可见的列名 */
    visibleColumns() {
      const fields = this.result.fields || [];
      return fields
        .filter((f) => this.toolbar.showColumns.includes(String(f.name).toLowerCase()))
        .map((f) => f.name);
    },
    /** 上一项/下一项：滚动到命中单元格 */
    navigateSearch(direction) {
      const matches = this.computeSearchMatches();
      if (!matches.length) {
        this.searchIndex = 0;
        return;
      }
      if (direction === "next") {
        this.searchIndex = (this.searchIndex + 1) % matches.length;
      } else {
        this.searchIndex =
          (this.searchIndex - 1 + matches.length) % matches.length;
      }
      this.scrollToCell(matches[this.searchIndex]);
    },
    /**
     * 定位到命中项。
     * 连续快速点击时容易错位，所以：
     * 1. 取消上一次待执行的定位（防抖到最近一次点击）
     * 2. 用组件 scrollToRow 定位，不依赖 DOM 顺序
     * 3. 行元素用 encodeURIComponent 后的 rowid 精确匹配
     * 4. 高亮用统一计时器管理，避免旧计时器清掉新高亮
     */
    scrollToCell(target) {
      if (!target) return;
      // 清掉上一轮还未执行完的定位，快速连点时只保留最后一次
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        const grid = this.$refs.dataTable;
        if (!grid) return;
        const rowData = this.rowDataAt(target.dataIndex);
        try {
          if (typeof grid.scrollToRow === "function" && rowData) {
            grid.scrollToRow(rowData);
          }
        } catch (e) {
          /* 组件不支持时走下面的 DOM 定位 */
        }
        this.$nextTick(() => {
          const rowEl = this.findRowElement(rowData, target.dataIndex);
          if (!rowEl) return;
          const cell = this.findCellElement(rowEl, target.column);
          this.applySearchHighlight(cell);
        });
      }, 30);
    },
    /** 高亮当前命中的单元格；用单一计时器避免旧回调误删新高亮 */
    applySearchHighlight(cell) {
      if (!cell) return;
      // 先清掉上一次的高亮，保证同一时刻只有一个框
      const app = document.getElementById("app");
      if (app) {
        Array.from(app.querySelectorAll(".search-current")).forEach((el) =>
          el.classList.remove("search-current")
        );
      }
      cell.classList.add("search-current");
      if (this.highlightTimer) clearTimeout(this.highlightTimer);
      this.highlightTimer = setTimeout(() => {
        cell.classList.remove("search-current");
      }, 2500);
    },
    /**
     * 在行里按列名找单元格。
     * 不能用下标：表格最前面还有复选框列和序号列，
     * visibleColumns 只包含数据列，按下标会整体偏移。
     * 组件的单元格带 col--<field> 类名，用它精确匹配。
     */
    findCellElement(rowEl, columnName) {
      const wanted = `col--${String(columnName).toLowerCase()}`;
      const cells = Array.from(rowEl.children);
      const hit = cells.find((cell) =>
        Array.from(cell.classList).some(
          (cls) => cls.toLowerCase() === wanted
        )
      );
      if (hit) return hit;
      // 兜底：按表头顺序在数据列中的位置推算，加上前置的复选框/序号列
      const idx = this.visibleColumns().indexOf(columnName);
      if (idx < 0) return null;
      return cells[idx + 2] || null;
    },
    /** 按数据行序号（不含过滤行）取真实行对象 */
    rowDataAt(dataIndex) {
      const rows = (this.result.data || []).filter((r) => r && !r.isFilter);
      return rows[dataIndex] || null;
    },
    /** 找到数据行对应的真实 DOM 行（排除固定列副表与过滤行） */
    findRowElement(rowData, dataIndex) {
      const grid = this.$refs.dataTable;
      if (!grid) return null;
      const root = grid.$el;
      // 只取主表体下的行，避免固定列区域的重复行
      const mainBody =
        root.querySelector(".plx-table--body-wrapper .plx-table--body") ||
        root.querySelector(".plx-table--body");
      const scope = mainBody || root;

      // 组件写入的 rowid 是 encodeURIComponent(_XID) 的结果，必须同样编码再比对
      if (rowData && rowData._XID != null) {
        const encoded = encodeURIComponent(rowData._XID);
        let hit = scope.querySelector(
          `.plx-body--row[data-rowid="${encoded}"]`
        );
        if (!hit) {
          // 某些版本不编码，再试一次原始值
          hit = scope.querySelector(
            `.plx-body--row[data-rowid="${rowData._XID}"]`
          );
        }
        if (hit) return hit;
      }

      // 退化：按可见顺序取（过滤行不参与）
      const rows = Array.from(scope.querySelectorAll(".plx-body--row")).filter(
        (r) => !r.classList.contains("row--filter")
      );
      return rows[dataIndex] || rows[0] || null;
    },
    /** 精确算出表格可用高度：视口高度减去工具栏、tab 栏等实际占用 */
    recalcHeight() {
      this.$nextTick(() => {
        // 有 flex 容器时直接量它的真实高度，比减视口可靠
        let wrap = null;
        if (this.$el && typeof this.$el.querySelector === "function") {
          wrap = this.$el.querySelector(".table-wrap");
        }
        if (wrap) {
          const h = Math.floor(wrap.getBoundingClientRect().height);
          if (h > 100) {
            this.remainHeight = h;
            this.afterHeightChange();
            return;
          }
        }
        // 回退：按兄弟元素累减
        const app = document.getElementById("app");
        if (!app) {
          this.remainHeight = window.innerHeight - 90;
          return;
        }
        let occupied = 0;
        const gridWrapper = this.$refs.dataTable
          ? this.$refs.dataTable.$el
          : null;
        Array.from(app.children).forEach((el) => {
          if (gridWrapper && (el === gridWrapper || el.contains(gridWrapper))) {
            return;
          }
          const style = window.getComputedStyle(el);
          if (style.display === "none") return;
          occupied += el.getBoundingClientRect().height;
        });
        this.remainHeight = Math.max(window.innerHeight - occupied - 4, 200);
        this.afterHeightChange();
      });
    },
    /** 高度变化后让表格重新测量，避免虚拟滚动按旧值算露出黑块 */
    afterHeightChange() {
      this.$nextTick(() => {
        if (
          this.$refs.dataTable &&
          typeof this.$refs.dataTable.recalculate === "function"
        ) {
          this.$refs.dataTable.recalculate();
        }
      });
    },
    /**
     * 翻页后重置表格内部状态。
     * ux-grid 的虚拟滚动会缓存滚动位置和行高，
     * 从空页翻回有数据的页时不重置就会白屏。
     */
    resetGridAfterPageChange() {
      const grid = this.$refs.dataTable;
      if (!grid) return;
      try {
        // 回到顶部，避免停在旧位置
        if (typeof grid.scrollTo === "function") {
          grid.scrollTo(0, 0);
        }
        // 清掉行高缓存并让表格重新测量
        if (typeof grid.recalculate === "function") {
          grid.recalculate();
        }
        // 数据被整体替换，强制重载一次
        if (typeof grid.reloadData === "function" && this.filterData) {
          grid.reloadData(this.filterData);
        }
      } catch (e) {
        // 组件版本差异时忽略，不影响主流程
      }
    },
    clear() {
      // reset page
      this.page.pageNum = 1;
      this.page.pageSize = this.result.pageSize;
      this.page.total = null;
      // info
      if (this.info.needRefresh) {
        this.info.message = null;
      } else {
        this.info.needRefresh = true;
      }
      // loading
      this.table.loading = false;
    },
    // show call when change table
    reset() {
      this.clear();
      // table
      this.table.widthItem = {};
      this.initShowColumn();
      // add filter row
      if (this.result.columnList) {
        this.result.data.unshift({ isFilter: true, content: "" });
      }
      // toolbar
      if (!this.result.sql.match(/\bwhere\b/gi)) {
        this.toolbar.filter = {};
        this.$refs.dataTable.clearSort();
      }
    },
    /** 给一份结果做快照，避免 tab 之间互相污染 */
    snapshotResult(data) {
      const snap = Object.assign({}, data);
      // 行数据必须深拷贝，否则编辑会串到别的 tab
      snap.data = (data.data || []).map((row) =>
        Object.assign({}, row)
      );
      snap.fields = (data.fields || []).map((f) => Object.assign({}, f));
      snap.columnList = (data.columnList || []).map((c) =>
        Object.assign({}, c)
      );
      return snap;
    },
    /** 按总行数回收旧 tab，避免内存被历史结果撑爆 */
    trimResultTabs() {
      const MAX_TABS = 30;
      const MAX_ROWS = 20000;
      // 先按数量限制
      while (this.resultTabs.length > MAX_TABS) {
        this.resultTabs.shift();
        this.activeTabIndex =
          this.activeTabIndex > 0 ? this.activeTabIndex - 1 : 0;
      }
      // 再按总行数限制：从最旧的开始丢，至少保留当前 tab
      let totalRows = this.resultTabs.reduce(
        (sum, t) => sum + ((t.result && t.result.data) ? t.result.data.length : 0),
        0
      );
      while (
        totalRows > MAX_ROWS &&
        this.resultTabs.length > 1 &&
        this.activeTabIndex > 0
      ) {
        const removed = this.resultTabs.shift();
        totalRows -= (removed.result && removed.result.data) ? removed.result.data.length : 0;
        this.activeTabIndex--;
      }
    },
    /** 数据行数：排除表格顶部那一行过滤占位行 */
    dataRowCount(result) {
      const data = (result && result.data) || [];
      return data.filter((r) => r && !r.isFilter).length;
    },
    /** 当前可见列名（按表格显示顺序） */
    currentColumns() {
      const fields = this.result.fields || [];
      return fields
        .filter((f) => this.toolbar.showColumns.includes(String(f.name).toLowerCase()))
        .map((f) => f.name);
    },
    /** 单元格取值，NULL 统一成空字符串，方便粘贴到 Excel */
    cellText(row, name) {
      const v = row ? row[name] : null;
      if (v === null || v === undefined) return "";
      if (v instanceof Date) return v.toISOString();
      return String(v);
    },
    /**
     * 写入剪贴板。
     * 优先用 webview 内的 navigator.clipboard（同步生效、能捕获失败），
     * 不可用时回退到扩展侧的 vscode.env.clipboard。
     */
    writeClipboard(text) {
      if (!text) return;
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(() => {
            this.$emit("sendToVscode", "copy", text);
          });
          return;
        }
      } catch (e) {
        // 忽略，走扩展侧
      }
      this.$emit("sendToVscode", "copy", text);
    },
    /** 复制整行；withHeader 时首行带列名 */
    copyRow(row, withHeader) {
      if (!row) return;
      const cols = this.currentColumns();
      const lines = [];
      if (withHeader) lines.push(cols.join("\t"));
      lines.push(cols.map((c) => this.cellText(row, c)).join("\t"));
      this.writeClipboard(lines.join("\n"));
    },
    /** 复制整列；withHeader 时首行是列名 */
    copyColumn(columnName, withHeader) {
      const cols = this.currentColumns();
      if (!cols.includes(columnName)) return;
      const rows = (this.result.data || []).filter((r) => r && !r.isFilter);
      const lines = [];
      if (withHeader) lines.push(columnName);
      rows.forEach((r) => lines.push(this.cellText(r, columnName)));
      this.writeClipboard(lines.join("\n"));
    },
    /** 复制整个表格（含表头），TSV 格式可直接粘进 Excel */
    copyAll(withHeader = true) {
      const cols = this.currentColumns();
      const rows = (this.result.data || []).filter((r) => r && !r.isFilter);
      const lines = [];
      if (withHeader) lines.push(cols.join("\t"));
      rows.forEach((r) => lines.push(cols.map((c) => this.cellText(r, c)).join("\t")));
      this.writeClipboard(lines.join("\n"));
    },
    /** 复制选中的多行（勾选框选中）；没选中时退回复制全部 */
    copySelected(withHeader = true) {
      const grid = this.$refs.dataTable;
      let rows = [];
      try {
        if (grid && typeof grid.getCheckboxRecords === "function") {
          rows = grid.getCheckboxRecords() || [];
        }
      } catch (e) {
        rows = [];
      }
      if (!rows.length) {
        this.copyAll(withHeader);
        return;
      }
      const cols = this.currentColumns();
      const lines = [];
      if (withHeader) lines.push(cols.join("\t"));
      rows.forEach((r) => lines.push(cols.map((c) => this.cellText(r, c)).join("\t")));
      this.writeClipboard(lines.join("\n"));
    },
    /** 双击进入单元格编辑 */
    onStartEdit(key) {
      this.editingKey = key;
    },
    /** 退出编辑态（点击表格其他区域、按 Esc、失焦时调用） */
    endEdit() {
      this.editingKey = "";
    },
    // ===== 选区模型 =====
    /** 数据行（排除过滤占位行），与表格显示顺序一致 */
    dataRows() {
      const data = this.result.data || [];
      // 只有明确标记 isFilter 的才是占位行；其他一律视为数据行，
      // 避免某些后端返回缺少字段时把真实数据误过滤掉。
      return data.filter((r) => r && r.isFilter !== true);
    },
    /** 当前选区是否有效 */
    hasSelection() {
      const s = this.selection;
      return s.anchorRow >= 0 && s.anchorCol !== "";
    },
    /** 选区覆盖的行范围与列范围（含端点） */
    selectionBounds() {
      const s = this.selection;
      if (!this.hasSelection()) return null;
      const cols = this.currentColumns();
      const rows = this.dataRows();
      let minRow = s.anchorRow;
      let maxRow = s.focusRow < 0 ? s.anchorRow : s.focusRow;
      if (s.byColumn) {
        // 整列选择：覆盖所有行
        minRow = 0;
        maxRow = Math.max(rows.length - 1, 0);
      } else if (minRow > maxRow) {
        const t = minRow; minRow = maxRow; maxRow = t;
      }

      // Ctrl 多选列：使用离散列集合，不含中间列
      if (s.byColumn && s.selectedCols && s.selectedCols.length) {
        const picked = s.selectedCols.filter((c) => cols.indexOf(c) >= 0);
        if (!picked.length) return null;
        const idxs = picked.map((c) => cols.indexOf(c));
        return {
          minRow,
          maxRow,
          minCol: Math.min.apply(null, idxs),
          maxCol: Math.max.apply(null, idxs),
          cols: picked,
          rows,
        };
      }

      const aCol = cols.indexOf(s.anchorCol);
      const fCol = cols.indexOf(s.focusCol);
      if (aCol < 0) return null;
      const minCol = fCol < 0 ? aCol : Math.min(aCol, fCol);
      const maxCol = fCol < 0 ? aCol : Math.max(aCol, fCol);
      return { minRow, maxRow, minCol, maxCol, cols: cols.slice(minCol, maxCol + 1), rows };
    },
    /** 判断某单元格是否在选区内（供样式使用） */
    isSelected(rowIndex, colName) {
      const b = this.selectionBounds();
      if (!b) return false;
      const colIdx = this.currentColumns().indexOf(colName);
      if (colIdx < 0) return false;
      return rowIndex >= b.minRow && rowIndex <= b.maxRow
        && colIdx >= b.minCol && colIdx <= b.maxCol;
    },
    /** 单击单元格：建立单格选区 */
    selectCell(rowIndex, colName, extend) {
      const s = this.selection;
      if (extend && s.anchorRow >= 0) {
        s.focusRow = rowIndex;
        s.focusCol = colName;
      } else {
        s.anchorRow = rowIndex;
        s.anchorCol = colName;
        s.focusRow = rowIndex;
        s.focusCol = colName;
        s.byColumn = false;
      }
    },
    /** 点击列头：整列选中；Shift 点击可扩展多列 */
    selectColumn(colName, extend) {
      const s = this.selection;
      if (extend && s.anchorCol) {
        s.focusCol = colName;
        s.focusRow = -1;
      } else {
        s.anchorRow = 0;
        s.anchorCol = colName;
        s.focusRow = -1;
        s.focusCol = colName;
      }
      s.byColumn = true;
    },
    /** 全选整个数据区 */
    selectAll() {
      const cols = this.currentColumns();
      const rows = this.dataRows();
      if (!cols.length || !rows.length) return;
      const s = this.selection;
      s.anchorRow = 0;
      s.anchorCol = cols[0];
      s.focusRow = rows.length - 1;
      s.focusCol = cols[cols.length - 1];
      s.byColumn = false;
    },
    /** 打开长内容查看器 */
    openViewer(payload) {
      if (!payload) return;
      this.viewer.content = payload.content || "";
      this.viewer.fieldName = payload.fieldName || "";
      this.viewer.fieldType = payload.fieldType || "";
      this.viewer.visible = true;
    },
    /** 某列是否在选区范围内（列头高亮用） */
    isColumnSelected(colName) {
      const b = this.selectionBounds();
      if (!b) return false;
      return b.cols.indexOf(colName) >= 0;
    },
    /** 列头双击：选中整列；Ctrl 累加离散多列（不包含中间列）；Shift 连续扩展 */
    onSelectColumn(colName, event) {
      const isMulti = !!(event && (event.ctrlKey || event.metaKey));
      const s = this.selection;
      if (isMulti) {
        // Ctrl 多选：维护一个离散列集合，只包含真正点过的列
        if (!s.byColumn || !s.selectedCols.length) {
          // 从当前单选列开始建集合（只收整列选区，单元格选区不该被算进来）
          s.selectedCols = s.byColumn && s.anchorCol ? [s.anchorCol] : [];
          s.byColumn = true;
        }
        const idx = s.selectedCols.indexOf(colName);
        if (idx >= 0) {
          // 再次 Ctrl 点击 -> 取消该列
          s.selectedCols.splice(idx, 1);
          s.selectedCols = s.selectedCols.slice();
          if (!s.selectedCols.length) {
            // 全部取消后清空选区
            this.clearSelection();
          } else {
            s.anchorCol = s.selectedCols[0];
            s.focusCol = s.selectedCols[0];
            s.anchorRow = 0;
            s.focusRow = -1;
          }
        } else {
          s.selectedCols.push(colName);
          s.selectedCols = s.selectedCols.slice();
          // anchorCol/focusCol 必须一起维护：hasSelection() 依赖 anchorCol 非空，
          // 只填 selectedCols 会导致"从空选区开始 Ctrl 双击"整列不亮、复制也拿不到列
          s.anchorCol = s.selectedCols[0];
          s.focusCol = s.selectedCols[0];
          s.anchorRow = 0;
          s.focusRow = -1;
        }
        return;
      }
      // 普通点击：清空多选集合，选中单列
      s.selectedCols = [];
      this.selectColumn(colName, event && event.shiftKey);
    },
    /** 清空选区 */
    clearSelection() {
      this.selection.anchorRow = -1;
      this.selection.anchorCol = "";
      this.selection.focusRow = -1;
      this.selection.focusCol = "";
      this.selection.byColumn = false;
      // 必须一并清空，否则 Ctrl 多选的格子会一直保持选中态
      this.selection.extras = [];
      this.selection.selectedCols = [];
    },
    /** 拖拽选择：鼠标按下开始，移动时更新焦点 */
    onCellMouseDown(rowIndex, colName, event) {
      if (event && event.button !== 0) return;
      // 正在编辑的单元格不参与拖选
      const key = rowIndex + "|" + colName;
      if (this.editingKey === key) return;

      const isCtrl = !!(event && (event.ctrlKey || event.metaKey));
      if (isCtrl) {
        // Ctrl+点击：把这一格追加为独立选区（可以是不相邻的多个格子）
        this.addExtraCell(rowIndex, colName);
        this.selection.dragging = false;
        return;
      }
      this.selectCell(rowIndex, colName, event && event.shiftKey);
      // 普通点击会重建主选区，先清掉之前 Ctrl 多选留下的残影
      this.selection.extras = [];
      this.selection.selectedCols = [];
      this.selection.dragging = true;
    },
    /** Ctrl 多选：追加一个独立单元格区域 */
    addExtraCell(rowIndex, colName) {
      const extras = this.selection.extras;
      // 已存在则取消选择（再次 Ctrl 点击取消）
      const exist = extras.findIndex(
        (e) => e.minRow === rowIndex && e.maxRow === rowIndex && e.cols.length === 1 && e.cols[0] === colName
      );
      if (exist >= 0) {
        extras.splice(exist, 1);
        return;
      }
      extras.push({ minRow: rowIndex, maxRow: rowIndex, cols: [colName] });
      // 让 Vue 能检测到变化
      this.selection.extras = extras.slice();
    },
    /** 某单元格是否命中额外选区 */
    isExtraSelected(rowIndex, colName) {
      const extras = this.selection.extras || [];
      return extras.some(
        (e) => rowIndex >= e.minRow && rowIndex <= e.maxRow && e.cols.indexOf(colName) >= 0
      );
    },
    onCellMouseEnter(rowIndex, colName) {
      if (!this.selection.dragging) return;
      this.selection.focusRow = rowIndex;
      this.selection.focusCol = colName;
      this.selection.byColumn = false;
    },
    onCellMouseUp() {
      this.selection.dragging = false;
    },
    /**
     * 复制勾选的行（复选框选中）。
     * 没勾选时退回复制当前选区。
     */
    copyCheckedRows(withHeader) {
      const grid = this.$refs.dataTable;
      let rows = [];
      try {
        if (grid && typeof grid.getCheckboxRecords === "function") {
          rows = grid.getCheckboxRecords() || [];
        }
      } catch (e) {
        rows = [];
      }
      // 排掉过滤占位行
      rows = rows.filter((r) => r && r.isFilter !== true);
      if (!rows.length) return false;
      const cols = this.currentColumns();
      const lines = [];
      if (withHeader) lines.push(cols.join("\t"));
      rows.forEach((r) => lines.push(cols.map((c) => this.cellText(r, c)).join("\t")));
      this.writeClipboard(lines.join("\n"));
      return true;
    },
    /** 复制选区内容，TSV 格式，可直接粘进 Excel */
    copySelection(withHeader) {
      // 有勾选行时优先复制勾选内容
      if (this.copyCheckedRows(withHeader)) return;
      const b = this.selectionBounds();
      const extras = this.selection.extras || [];
      const rows = this.dataRows();

      // 没有任何主选区、但有 Ctrl 多选的格子
      if (!b || !b.cols.length) {
        if (!extras.length) {
          this.copyAll(withHeader !== false);
          return;
        }
        const lines = [];
        extras.forEach((e) => {
          for (let i = e.minRow; i <= e.maxRow; i++) {
            const row = rows[i];
            if (!row) continue;
            lines.push(e.cols.map((c) => this.cellText(row, c)).join("\t"));
          }
        });
        if (lines.length) this.writeClipboard(lines.join("\n"));
        return;
      }

      // 输出列 = 主选区列 + extras 列（去重，保持顺序）
      const cols = b.cols.slice();
      extras.forEach((e) => e.cols.forEach((c) => { if (cols.indexOf(c) < 0) cols.push(c); }));

      // 输出行 = 主选区行范围 ∪ 所有 extras 的行范围（关键：
      // 之前只遍历主选区行，导致 extras 里其他行的数据全丢）
      let minRow = b.minRow;
      let maxRow = b.maxRow;
      extras.forEach((e) => {
        if (e.minRow < minRow) minRow = e.minRow;
        if (e.maxRow > maxRow) maxRow = e.maxRow;
      });

      const lines = [];
      if (withHeader) lines.push(cols.join("\t"));
      for (let i = minRow; i <= maxRow; i++) {
        const row = rows[i];
        if (!row) continue;
        // 这一行是否被任一选区覆盖
        const inMainRows = i >= b.minRow && i <= b.maxRow;
        const hitExtras = extras.filter((e) => i >= e.minRow && i <= e.maxRow);
        if (!inMainRows && !hitExtras.length) continue;

        const line = cols.map((c) => {
          if (inMainRows && b.cols.indexOf(c) >= 0) {
            return this.cellText(row, c);
          }
          if (hitExtras.some((e) => e.cols.indexOf(c) >= 0)) {
            return this.cellText(row, c);
          }
          return "";
        }).join("\t");
        // 整行都是空占位就跳过，避免输出大量空白行
        if (!line.replace(/\t/g, "").trim()) continue;
        lines.push(line);
      }
      const text = lines.join("\n");
      if (!text) return;
      this.writeClipboard(text);
    },
    /**
     * 切换「全部数据 / 分页」模式。
     * 全量加载会去掉 LIMIT 重新查询，最多加载 MAX_ALL_ROWS 行，
     * 超过则提示用户改用筛选或分页，避免把内存打爆。
     */
    toggleShowAll() {
      const MAX_ALL_ROWS = 50000;
      const sql = this.result.sql || "";
      if (!sql) return;

      if (this.showAllMode) {
        // 恢复分页：用进入全量模式前的原始 SQL 重新查询
        this.showAllMode = false;
        this.clearSelection();
        const original = this.originalSql || this.result.sql || "";
        this.execute(original);
        return;
      }

      if (this.page.total != null && this.page.total > MAX_ALL_ROWS) {
        this.$message({
          message: this.$t("status.tooManyRows", { n: this.page.total, max: MAX_ALL_ROWS }),
          type: "warning",
          duration: 3000,
        });
        return;
      }

      // 记下原始 SQL，退出全量模式时用它恢复
      this.originalSql = sql;
      // 去掉末尾 limit，改为加载全部（带上限）
      const base = sql.trim().replace(/;+\s*$/, "").replace(/\s+limit\s+\d+(\s*,\s*\d+)?\s*$/i, "");
      this.showAllMode = true;
      this.clearSelection();
      // 传 noAutoPaging，避免扩展侧自动分页把我们的 LIMIT 再改回 100
      this.execute(`${base} LIMIT ${MAX_ALL_ROWS + 1}`, true);
      this.$message({ message: this.$t("status.loadingAll"), type: "info", duration: 1500 });
    },
    /** 切换每页行数后重新查询第一页 */
    reloadWithPageSize(size) {
      console.log("[paging] reloadWithPageSize", { size, sql: this.result.sql, pageNum: this.page.pageNum });
      if (!size) return;
      if (!this.result.sql) {
        // 没有 SQL 说明当前结果区还没有可用查询，直接返回
        this.$message({ message: this.$t("status.noQuery"), type: "warning", duration: 1500 });
        return;
      }
      this.page.pageNum = 1;
      this.page.total = null;
      this.clearSelection();
      vscodeEvent.emit("next", {
        sql: this.result.sql,
        pageNum: 1,
        pageSize: size,
      });
      this.table.loading = true;
    },
    /** 工具栏复制菜单分发 */
    handleCopyAction(cmd) {
      switch (cmd) {
        case "selected": this.copySelected(true); break;
        case "selectedNoHeader": this.copySelected(false); break;
        case "all": this.copyAll(true); break;
        case "allNoHeader": this.copyAll(false); break;
      }
    },
    /** 生成 tab 标题：有表名用表名，否则截断 SQL */
    buildTabTitle(data) {
      if (data && data.table) return data.table;
      const sql = (data && data.sql) || "";
      const oneLine = sql.replace(/\s+/g, " ").trim();
      return oneLine.length > 22 ? oneLine.slice(0, 22) + "…" : oneLine || "结果";
    },
    /** 把一次查询结果登记为 tab，并切到该 tab */
    pushResultTab(data) {
      const title = this.buildTabTitle(data);
      const snap = this.snapshotResult(data);
      // 同一份 SQL 重复执行时复用原 tab，避免刷屏
      const existIndex = this.resultTabs.findIndex(
        (t) => t.sql === data.sql && t.title === title
      );
      if (existIndex >= 0) {
        this.resultTabs.splice(existIndex, 1, {
          id: this.tabSeq++,
          title,
          sql: data.sql,
          result: snap,
        });
        this.activeTabIndex = existIndex;
        return;
      }
      this.resultTabs.push({
        id: this.tabSeq++,
        title,
        sql: data.sql,
        result: snap,
      });
      this.activeTabIndex = this.resultTabs.length - 1;
      // 按“总行数”而不是“tab 个数”控制内存：
      // 30 个 tab 各存一份几千行结果会吃掉几百 MB
      this.trimResultTabs();
    },
    /** 切换 tab，恢复该 tab 的结果快照 */
    switchTab(index) {
      const tab = this.resultTabs[index];
      if (!tab) return;
      this.activeTabIndex = index;
      this.result = this.snapshotResult(tab.result);
      this.toolbar.sql = this.result.sql;
      this.table.widthItem = {};
      this.initShowColumn();
      this.page.pageNum = 1;
      this.update.editList = [];
    },
    closeTab(index) {
      if (index < 0 || index >= this.resultTabs.length) { return; }
      const wasActive = index === this.activeTabIndex;
      this.resultTabs.splice(index, 1);
      if (this.resultTabs.length === 0) {
        this.activeTabIndex = 0;
        return;
      }
      if (index < this.activeTabIndex) {
        // 关掉的是当前 tab 左边的，活动项索引要跟着左移
        this.activeTabIndex--;
      } else if (this.activeTabIndex >= this.resultTabs.length) {
        this.activeTabIndex = this.resultTabs.length - 1;
      }
      if (wasActive) {
        this.switchTab(this.activeTabIndex);
      }
    },
    /**
     * 鼠标中键关闭 tab。
     * 中键会同时触发 mousedown 和 auxclick，这里做去重避免关掉两个 tab。
     */
    closeTabByMiddle(index) {
      const now = Date.now();
      if (this.lastMiddleCloseAt && now - this.lastMiddleCloseAt < 300
        && this.lastMiddleCloseIndex === index) {
        return;
      }
      this.lastMiddleCloseAt = now;
      this.lastMiddleCloseIndex = index;
      this.closeTab(index);
    },
    closeAllTabs() {
      this.resultTabs = [];
      this.activeTabIndex = 0;
    },
  },
  computed: {
    /**
     * 选区边界快照，作为普通数据传给子组件。
     * 注意：必须定义在 computed 里，不是 methods。
     */
    selectionSnapshot() {
      const extras = (this.selection.extras || []).map((e) => ({
        minRow: e.minRow,
        maxRow: e.maxRow,
        cols: e.cols.slice(),
      }));
      const b = this.selectionBounds();
      if (!b) {
        // 主选区为空但有 Ctrl 多选的格子时，仍要返回 extras 供高亮
        return extras.length ? { minRow: -1, maxRow: -1, cols: [], extras } : null;
      }
      return {
        minRow: b.minRow,
        maxRow: b.maxRow,
        cols: b.cols.slice(),
        extras,
      };
    },
    /** 所有命中位置，工具栏用于显示 x/y 计数 */
    searchMatches() {
      return this.computeSearchMatches();
    },
    filterData() {
      // 搜索改为高亮模式：不再过滤行，全部展示，匹配内容在单元格里高亮
      return this.result.data;
    },
    editable() {
      return this.result.primaryKey && this.result.tableCount == 1;
    },
    columnCount() {
      if (this.result.data == undefined || this.result.data[0] == undefined)
        return 0;
      return Object.keys(this.result.data[0]).length;
    },
  },
};
</script>