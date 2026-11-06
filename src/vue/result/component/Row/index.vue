<template>
  <div>
    <template v-if="scope.row.isFilter">
      <el-input class='edit-filter' v-model="filterObj[scope.column.title]" :clearable='true' :placeholder="$t('filter.placeholder')" @clear="filter(null,scope.column.title)" @keyup.enter.native="filter($event,scope.column.title)">
      </el-input>
    </template>
    <template v-else-if="!scope.row.isFilter && result.dbType=='ElasticSearch'">
      <div class="edit-column" :class="{ 'is-editing': isEditing(scope) }" :contenteditable="editingKey === cellKey(scope)" style="height: 100%; line-height: 33px;" @input="editListen($event,scope)" @contextmenu.prevent="onContextmenu($event,scope)" @dblclick="startEdit(scope)" v-html='dataformat(scope.row[scope.column.title])'></div>
    </template>
    <template v-else>
      <div class="edit-column"
           :class="{ 'is-editing': isEditing(scope), 'is-selected': selected, 'has-expand': needExpand }"
           :contenteditable="editingKey === cellKey(scope)"
           style="height: 100%; line-height: 33px;"
           @input="editListen($event,scope)"
           @contextmenu.prevent="onContextmenu($event,scope)"
           @mousedown="onMouseDown($event, scope)"
           @mouseenter="onMouseEnter(scope)"
           @dblclick="startEdit(scope, $event)">
        <!-- 编辑态渲染纯文本节点，不再包 span：
             内层元素会让 e.target 不是 .edit-column 本身，
             父组件的「点外关闭编辑」判定会误伤，且光标定位会落在子节点上。 -->
        <template v-if="isEditing(scope)">
          <template v-if="scope.row[scope.column.title]==null || scope.row[scope.column.title]==undefined">(NULL)</template>
          <template v-else>{{ dataformat(scope.row[scope.column.title]) }}</template>
        </template>
        <template v-else>
          <template v-if="scope.row[scope.column.title]==null || scope.row[scope.column.title]==undefined">
            <span class='null-column'>(NULL)</span>
          </template>
          <template v-else-if="searchKeyword">
            <span v-html="highlight(dataformat(scope.row[scope.column.title]))"></span>
          </template>
          <template v-else>
            <span v-text='dataformat(scope.row[scope.column.title])'></span>
          </template>
          <!-- 内容被列宽截断时在右侧给一个展开按钮（不参与编辑，点击不触发选中） -->
          <span
            v-if="needExpand"
            class="cell-expand"
            :class="{ 'cell-expand--json': isJsonValue }"
            :title="isJsonValue ? $t('cell.viewJson') : $t('cell.viewFull')"
            @mousedown.stop.prevent
            @click.stop.prevent="openViewer"
          >+</span>
        </template>
      </div>
    </template>
  </div>
</template>

<script>
import { wrapByDb } from "@/common/wrapper";

export default {
  props: ["result", "scope", "editList","filterObj","searchKeyword","editingKey","selection"],
  data() {
    return {
      /** 实测是否被裁（scrollWidth/Height 超出 client 尺寸），由 measureOverflow 维护 */
      overflow: false,
      /** 是否已经测量过，避免首帧用兜底阈值反复抖动 */
      measured: false,
    };
  },
  mounted() {
    this.scheduleMeasure();
  },
  updated() {
    // 注意：measureOverflow 会写 this.overflow，而 overflow 参与 needExpand，
    // needExpand 又控制加号渲染 —— 直接在这里同步测量会形成「测量→渲染→再测量」的循环。
    // 用 scheduleMeasure 做节流，且 measureOverflow 内部有 next !== overflow 守卫，
    // 保证值稳定后不再触发新的一轮。
    this.scheduleMeasure();
  },
  beforeDestroy() {
    if (this.measureTimer) {
      // requestAnimationFrame 返回数字 ID，只能用 cancelAnimationFrame 取消
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.measureTimer);
      clearTimeout(this.measureTimer);
      this.measureTimer = null;
    }
  },
  computed: {
    /**
     * 当前单元格是否在选区内。
     * 基于父组件传来的选区快照计算，不再回调父级方法，
     * 避免渲染期抛错导致整张表格只出表头不出数据。
     */
    selected() {
      try {
        const sel = this.selection;
        if (!sel) return false;
        const s = this.scope;
        if (!s || !s.column) return false;
        const colName = s.column.title;
        const dataIdx = this.dataRowIndex(s.rowIndex);

        // 主选区命中
        if (sel.cols && sel.cols.length
          && sel.cols.indexOf(colName) >= 0
          && dataIdx >= sel.minRow && dataIdx <= sel.maxRow) {
          return true;
        }
        // Ctrl 多选的额外区域命中
        const extras = sel.extras || [];
        return extras.some(
          (e) => dataIdx >= e.minRow && dataIdx <= e.maxRow && e.cols.indexOf(colName) >= 0
        );
      } catch (e) {
        return false;
      }
    },
    /** 是否允许编辑（单表且有主键） */
    editable() {
      return this.result.primaryKey && this.result.tableCount == 1;
    },
    /** 当前单元格的原始值（字符串形式） */
    cellRawText() {
      try {
        const s = this.scope;
        if (!s || !s.column) return "";
        const v = s.row ? s.row[s.column.title] : null;
        if (v === null || v === undefined) return "";
        return String(this.dataformat(v));
      } catch (e) {
        return "";
      }
    },
    /**
     * 是否需要展开按钮。
     *
     * 原实现用「字符数 > 40」这个硬编码阈值，和列宽完全脱钩：
     * 33 个中文字在窄列里早就被省略号截断了却不给按钮，
     * 而 41 个字符在宽列里明明显示得下却给按钮 —— 表现就是"时有时无"。
     *
     * 现在改为按真实渲染溢出判定（scrollWidth > clientWidth）：
     * 只要显示被截断就给按钮，显示得下就不给。同时保底处理
     * 多行文本（含换行符）——那种内容即使宽列也放不进一行。
     */
    needExpand() {
      // 编辑态时不显示按钮，避免干扰输入
      if (this.editingKey === this.cellKey(this.scope)) return false;
      const text = this.cellRawText;
      if (!text) return false;
      // 多行文本必然需要查看器
      if (/[\r\n]/.test(text)) return true;
      // 有明显溢出记录（由 measureOverflow 在渲染后测量）
      if (this.overflow) return true;
      // 测量还没跑过时，用一个宽松的兜底：极长内容直接给按钮，
      // 避免首帧闪一下没有按钮。阈值按字符宽度估算，中文算 2。
      if (!this.measured) {
        const visualWidth = text.replace(/[^\x00-\xff]/g, "aa").length;
        return visualWidth > 28;
      }
      return false;
    },
    /** 值是否为 JSON（用于按钮提示与样式） */
    isJsonValue() {
      const text = this.cellRawText.trim();
      if (!text) return false;
      if (text[0] !== "{" && text[0] !== "[") return false;
      try {
        JSON.parse(text);
        return true;
      } catch (e) {
        return false;
      }
    },
  },
  methods: {
    /**
     * 把测量排到下一帧，同一帧内的多次调用只跑一次。
     * 直接在每个 updated 里同步测量，在几百行的表格上会反复触发重排。
     */
    scheduleMeasure() {
      if (this.measureTimer) return;
      const raf = typeof window !== "undefined" && window.requestAnimationFrame;
      if (raf) {
        this.measureTimer = raf(() => {
          this.measureTimer = null;
          this.measureOverflow();
        });
      } else {
        this.measureTimer = setTimeout(() => {
          this.measureTimer = null;
          this.measureOverflow();
        }, 16);
      }
    },
    /**
     * 测量当前单元格是否被截断。
     *
     * 用 scrollWidth/scrollHeight 与 clientWidth/clientHeight 比较，
     * 而不是数字符：中文宽度是英文两倍，列宽又由内容动态算出（上限 340px），
     * 行高固定 30px，长文本会换行后被纵向裁掉 —— 按字符数根本判不准。
     *
     * 必须两个方向都测：文本默认会换行，所以溢出通常表现为
     * scrollHeight 变大（纵向裁），而不是 scrollWidth（横向省略号）。
     */
    measureOverflow() {
      try {
        const el = this.$el && this.$el.querySelector
          ? this.$el.querySelector(".edit-column")
          : null;
        if (!el) return;
        // 编辑态下元素是 overflow:visible，量出来没有意义
        if (this.editingKey === this.cellKey(this.scope)) return;
        const horizontal = el.scrollWidth > el.clientWidth + 1;
        const vertical = el.scrollHeight > el.clientHeight + 1;
        const next = horizontal || vertical;
        this.measured = true;
        if (next !== this.overflow) this.overflow = next;
      } catch (e) {
        this.measured = true;
      }
    },
    /**
     * 把表格行索引换算成「数据行序号」。
     * 关键：返回值必须是排除过滤行之后的序号，
     * 因为父组件的选区模型（selectionBounds）用的是 dataRows() 的下标。
     * 之前这里返回的是原始数组下标，多了一个过滤行的偏移，
     * 导致选中"新安1店"却复制出"雷霆店"（整体错位）。
     */
    dataRowIndex(gridRowIndex) {
      try {
        const data = (this.result && this.result.data) || [];
        if (typeof gridRowIndex !== "number" || gridRowIndex < 0) return 0;
        let count = 0;
        for (let i = 0; i < data.length; i++) {
          if (data[i] && data[i].isFilter === true) continue;
          // 表格行索引即为 data 数组下标；找到后返回它之前有多少条数据
          if (i === gridRowIndex) return count;
          count++;
        }
        // 超出范围时返回最后一条数据序号
        return Math.max(count - 1, 0);
      } catch (e) {
        return 0;
      }
    },
    onMouseDown(event, scope) {
      if (!scope || !scope.column) return;
      // 编辑态下不参与选区：否则每次点击都会重建选区，
      // 打断浏览器原生的光标定位与拖动选择。
      if (this.editingKey === this.cellKey(scope)) return;
      const dataIdx = this.dataRowIndex(scope.rowIndex);
      this.$emit("selectCell", dataIdx, scope.column.title, event);
    },
    onMouseEnter(scope) {
      if (!scope || !scope.column) return;
      const dataIdx = this.dataRowIndex(scope.rowIndex);
      this.$emit("enterCell", dataIdx, scope.column.title);
    },
    /** 单元格唯一标识：行索引 + 列名 */
    cellKey(scope) {
      const s = scope || this.scope;
      if (!s) return "";
      const idx = s.rowIndex;
      const col = s.column && s.column.title;
      return idx + "|" + col;
    },
    /** 当前单元格是否处于编辑态 */
    isEditing(scope) {
      return this.editingKey === this.cellKey(scope);
    },
    /**
     * 双击进入编辑。
     *
     * 不再自动全选内容：全选后只要一拖鼠标就变成"替换整个内容"，
     * 光标落点被吞掉，用户既不能自由移动光标也不能自由圈选。
     * 现在把光标放到双击的落点上，和 Excel 双击进编辑的体感一致。
     */
    startEdit(scope, event) {
      if (!this.editable) return;
      const key = this.cellKey(scope);
      if (this.editingKey === key) return;   // 已在编辑态，交给浏览器原生处理
      this.$emit("startEdit", key);
      const point = event ? { x: event.clientX, y: event.clientY } : null;
      this.$nextTick(() => {
        const el = this.findEditElement();
        if (!el) return;
        el.focus();
        this.placeCaret(el, point);
      });
    },
    /** 找到当前正在编辑的那个 .edit-column 元素 */
    findEditElement() {
      try {
        // 注意：不能用 this.editingKey 校验。刚 $emit("startEdit") 时
        // 父组件的 editingKey 要到下一轮渲染才传回来，$nextTick 里读到的
        // 可能还是旧值，据此 return null 会导致光标根本没被放置。
        // 直接找 DOM 里带 is-editing 且可编辑的那个。
        const all = document.querySelectorAll(".edit-column.is-editing");
        for (let i = 0; i < all.length; i++) {
          if (all[i].isContentEditable) return all[i];
        }
        const el = document.activeElement;
        if (el && el.classList && el.classList.contains("edit-column") && el.isContentEditable) {
          return el;
        }
        return null;
      } catch (e) {
        return null;
      }
    },
    /**
     * 把光标放到点击位置。caretRangeFromPoint 不可用时退回到内容末尾。
     * 关键：只放置光标（collapsed），不建立任何选区。
     */
    placeCaret(el, point) {
      try {
        const sel = window.getSelection && window.getSelection();
        if (!sel) return;
        const doc = document;

        // 1) 优先按双击落点定位
        if (point) {
          let hit = null;
          if (doc.caretRangeFromPoint) {
            hit = doc.caretRangeFromPoint(point.x, point.y);
          } else if (doc.caretPositionFromPoint) {
            const pos = doc.caretPositionFromPoint(point.x, point.y);
            if (pos) {
              hit = doc.createRange();
              hit.setStart(pos.offsetNode, pos.offset);
            }
          }
          if (hit && el.contains(hit.startContainer)) {
            // 统一用 range.collapse(true)：折叠到落点，不建立选区。
            // 不用 sel.collapse()，它在 container 为文本节点时部分浏览器会抛错。
            hit.collapse(true);
            sel.removeAllRanges();
            sel.addRange(hit);
            return;
          }
        }

        // 2) 拿不到落点（或落点在单元格外）→ 光标放到内容末尾
        const end = doc.createRange();
        end.selectNodeContents(el);
        end.collapse(false);
        sel.removeAllRanges();
        sel.addRange(end);
      } catch (e) {
        /* 忽略：拿不到光标位置时保持浏览器默认行为 */
      }
    },
    /** 打开查看器，展示完整内容 */
    openViewer() {
      const s = this.scope;
      if (!s || !s.column) return;
      this.$emit("openViewer", {
        content: this.cellRawText,
        fieldName: s.column.title,
        fieldType: this.columnMeta ? this.columnMeta.type : "",
      });
    },
    dataformat(origin) {
      if (origin == undefined || origin == null) {
        return "<span class='null-column'>(NULL)</span>";
      }
      if (origin.hasOwnProperty("type")) {
        return String.fromCharCode.apply(null, new Uint16Array(origin.data));
      }
      return origin;
    },
    /** 把匹配到的关键字包上高亮标签，先转义 HTML 防止 XSS */
    highlight(value) {
      const text = String(value == null ? "" : value);
      const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      const keyword = String(this.searchKeyword || "");
      if (!keyword) return escaped;
      // 转义正则特殊字符，避免用户输入 . * 等导致匹配异常
      const safe = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(safe, "gi");
      // 用占位符避免重复匹配已包裹的内容
      return escaped.replace(re, (m) => `\u0001${m}\u0002`)
        .replace(/\u0001/g, "<mark class='search-highlight'>")
        .replace(/\u0002/g, "</mark>");
    },
    editListen(event, scope) {
      const { row, column, rowIndex } = scope;
      // 关键：必须把"表格行索引"换算成"数据行序号"。
      // 表格首行是筛选占位行，直接用 scope.rowIndex 会整体错位一行，
      // 导致保存时 UPDATE 的 WHERE 指向错误记录（曾把别的行主键一起改掉）。
      const dataIdx = this.dataRowIndex(rowIndex);
      const editList = this.editList.concat([]);
      if (!editList[dataIdx]) {
        editList[dataIdx] = { ...row };
        delete editList[dataIdx]._XID;
      }
      editList[dataIdx][column.title] = event.target.textContent;
      this.$emit("sendToVscode", "dataModify");
      this.$emit("update:editList", editList);
    },
    filter(event, column, operation) {
      if (!operation) operation = "=";
      let inputvalue = "" + (event ? event.target.value : "");
      if (this.result.dbType == "ElasticSearch") {
        this.$emit("sendToVscode", "esFilter", {
          match: { [column]: inputvalue },
        });
        return;
      }

      let filterSql =
        this.result.sql.replace(/\n/, " ").replace(";", " ") + " ";

      let existsCheck = new RegExp(
        `(WHERE|AND)?\\s*\`?${column}\`?\\s*(=|is|>=|<=|<>)\\s*.+?\\s`,
        "igm"
      );

      if (inputvalue) {
        const condition =
          inputvalue.toLowerCase() === "null"
            ? `${column} is null`
            : `${wrapByDb(
                column,
                this.result.dbType
              )} ${operation} '${inputvalue}'`;
        if (existsCheck.exec(filterSql)) {
          // condition present
          filterSql = filterSql.replace(existsCheck, `$1 ${condition} `);
        } else if (filterSql.match(/\bwhere\b/gi)) {
          //have where
          filterSql = filterSql.replace(
            /\b(where)\b/gi,
            `\$1 ${condition} AND `
          );
        } else {
          //have not where
          filterSql = filterSql.replace(
            new RegExp(`(from\\s*.+?)\\s`, "ig"),
            `\$1 WHERE ${condition} `
          );
        }
      } else {
        // empty value, clear filter
        let beforeAndCheck = new RegExp(
          `\\b${column}\\b\\s*(=|is)\\s*.+?\\s*AND`,
          "igm"
        );
        if (beforeAndCheck.exec(filterSql)) {
          filterSql = filterSql.replace(beforeAndCheck, "");
        } else {
          filterSql = filterSql.replace(existsCheck, " ");
        }
      }
      this.$emit("execute", filterSql + ";");
    },
    onContextmenu(event, scope) {
      const { row, column } = scope;
      const name = column.title;
      const value = event.target.textContent;
      event.target.value = value;
      this.$contextmenu({
        items: [
          {
            label: this.$t('ctx.copyCell'),
            onClick: () => this.$emit("sendToVscode", "copy", value),
            divided: true,
          },
          {
            label: this.$t('ctx.copyRow'),
            onClick: () => this.$emit("copyRow", row),
          },
          {
            label: this.$t('ctx.copyRowHeader'),
            onClick: () => this.$emit("copyRow", row, true),
          },
          {
            label: this.$t('ctx.copyCol', { name }),
            onClick: () => this.$emit("copyColumn", name, false),
          },
          {
            label: this.$t('ctx.copyColHeader', { name }),
            onClick: () => this.$emit("copyColumn", name, true),
            divided: true,
          },
          {
            label: this.$t('ctx.editRow'),
            onClick: () => {
              this.$emit("openEditor", row, false);
            },
          },
          {
            label: this.$t('ctx.insertCopy'),
            onClick: () => {
              this.$emit("openEditor", row, true);
            },
            divided: true,
          },
          {
            label: `筛选「${name} = ${value}」`,
            onClick: () => {
              this.filter(event, name, "=");
            },
          },
          {
            label: this.$t('filter.byCondition'),
            divided: true,
            children: [
              {
                label: `大于「${value}」`,
                onClick: () => {
                  this.filter(event, name, ">");
                },
              },
              {
                label: `大于等于「${value}」`,
                onClick: () => {
                  this.filter(event, name, ">=");
                },
                divided: true,
              },
              {
                label: `小于「${value}」`,
                onClick: () => {
                  this.filter(event, name, "<");
                },
              },
              {
                label: `小于等于「${value}」`,
                onClick: () => {
                  this.filter(event, name, "<=");
                },
                divided: true,
              },
              {
                label: `包含「${value}」`,
                onClick: () => {
                  event.target.value = `%${value}%`;
                  this.filter(event, name, "LIKE");
                },
              },
              {
                label: `不包含「${value}」`,
                onClick: () => {
                  event.target.value = `%${value}%`;
                  this.filter(event, name, "NOT LIKE");
                },
              },
            ],
          },
        ],
        event,
        customClass: "class-a",
        zIndex: 3,
        minWidth: 230,
      });
      return false;
    },
  },
};
</script>

<style>
</style>