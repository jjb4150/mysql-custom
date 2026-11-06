<template>
  <el-dialog
    :title="title"
    :visible="visible"
    width="62%"
    top="6vh"
    custom-class="cell-viewer"
    @close="$emit('update:visible', false)"
  >
    <div class="cell-viewer__meta">
      <span class="cell-viewer__field">{{ fieldName }}</span>
      <span class="cell-viewer__type" v-if="fieldType">{{ fieldType }}</span>
      <span class="cell-viewer__count">{{ charCount }} 字符</span>
      <span v-if="isJson" class="cell-viewer__badge">JSON</span>
    </div>

    <!-- JSON 用美化视图 -->
    <pre v-if="isJson" class="cell-viewer__json" v-html="highlighted"></pre>
    <!-- 普通长文本 -->
    <pre v-else class="cell-viewer__text">{{ content }}</pre>

    <span slot="footer" class="cell-viewer__footer">
      <el-button size="mini" @click="toggleWrap">{{ wrap ? "关闭自动换行" : "自动换行" }}</el-button>
      <el-button size="mini" type="primary" @click="copy">复制内容</el-button>
      <el-button size="mini" @click="$emit('update:visible', false)">关闭</el-button>
    </span>
  </el-dialog>
</template>

<script>
export default {
  props: ["visible", "content", "fieldName", "fieldType"],
  data() {
    return {
      wrap: true,
    };
  },
  computed: {
    charCount() {
      return String(this.content == null ? "" : this.content).length;
    },
    /** 判断内容是不是 JSON：以 { 或 [ 开头且能解析 */
    isJson() {
      const text = this.trimmed;
      if (!text) return false;
      if (text[0] !== "{" && text[0] !== "[") return false;
      try {
        JSON.parse(text);
        return true;
      } catch (e) {
        return false;
      }
    },
    trimmed() {
      return String(this.content == null ? "" : this.content).trim();
    },
    /**
     * JSON 美化 + 语法高亮。
     *
     * 安全要点：绝不能把 json-format-highlight 的输出直接交给 v-html。
     * 该库只对字符串「值」做 escapeHtml，对「键名」分支不转义，
     * 数据库里只要有一行 JSON 的键名是 `<img src=x onerror=...>`
     * 就会在查看器里执行（XSS 已实测复现）。
     *
     * 这里改成自己高亮：先整体 escapeHtml，再只在已转义的文本上
     * 用正则加 <span> 包颜色，任何来自数据的字符都不可能变成标签。
     */
    highlighted() {
      try {
        const obj = JSON.parse(this.trimmed);
        const pretty = JSON.stringify(obj, null, 2);
        return this.highlightJson(pretty);
      } catch (e) {
        return this.escapeHtml(this.trimmed);
      }
    },
    title() {
      return "查看内容";
    },
  },
  watch: {
    visible(v) {
      if (v) this.wrap = true;
    },
  },
  methods: {
    escapeHtml(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    },
    /**
     * 对已格式化的 JSON 文本做高亮。
     *
     * 做法：先对整段文本 escapeHtml，之后的所有操作都只在「已转义文本」上进行。
     * 加进去的只有本方法自己写的 <span style="...">，数据里的 < > & 已经是实体，
     * 因此不存在注入路径。
     *
     * scope 内的字符集特意排除 `<`（数据中的 < 已变成 &lt;，不含裸 <），
     * 保证匹配不会跨越到注入的标签上。
     */
    highlightJson(pretty) {
      const escaped = this.escapeHtml(pretty);
      const KEY = "#7ec699";
      const STR = "#a8d08d";
      const NUM = "#f08d49";
      const LIT = "#cc99cd";
      const mark = (color, text) => `<span style="color:${color}">${text}</span>`;

      // 逐字符扫描，避免正则回溯在超长 JSON 上的性能问题
      let out = "";
      let i = 0;
      const len = escaped.length;
      while (i < len) {
        const ch = escaped[i];

        // 字符串：含键名（后面紧跟冒号）与普通值
        if (ch === '"') {
          let j = i + 1;
          while (j < len) {
            if (escaped[j] === "\\") { j += 2; continue; }
            if (escaped[j] === '"') { break; }
            j++;
          }
          const token = escaped.slice(i, j + 1);
          // 跳过空白看下一个非空字符是不是冒号
          let k = j + 1;
          while (k < len && /\s/.test(escaped[k])) k++;
          const isKey = escaped[k] === ":";
          out += mark(isKey ? KEY : STR, token);
          i = j + 1;
          continue;
        }

        // 数字
        if (/[-0-9]/.test(ch)) {
          let j = i;
          while (j < len && /[-+.eE0-9]/.test(escaped[j])) j++;
          out += mark(NUM, escaped.slice(i, j));
          i = j;
          continue;
        }

        // true / false / null
        if (/[tfn]/.test(ch)) {
          const rest = escaped.slice(i, i + 5);
          const lit = ["true", "false", "null"].find((w) => rest.startsWith(w));
          if (lit) {
            out += mark(LIT, lit);
            i += lit.length;
            continue;
          }
        }

        out += ch;
        i++;
      }
      return out;
    },
    toggleWrap() {
      this.wrap = !this.wrap;
    },
    copy() {
      const text = this.content == null ? "" : String(this.content);
      this.$emit("copy", text);
    },
  },
};
</script>

<style>
.cell-viewer .el-dialog__body {
  padding: var(--mc-sp-2) var(--mc-sp-4) var(--mc-sp-1);
}

.cell-viewer__meta {
  display: flex;
  align-items: center;
  gap: var(--mc-sp-3);
  font-size: var(--mc-fs);
  padding-bottom: var(--mc-sp-2);
  border-bottom: 1px solid var(--mc-border);
  margin-bottom: var(--mc-sp-2);
  min-width: 0;
}

.cell-viewer__field {
  font-weight: 600;
  font-size: var(--mc-fs-md);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.cell-viewer__type {
  color: var(--mc-fg-dim);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--mc-fs-sm);
  opacity: 0.8;
  flex: none;
}

.cell-viewer__count {
  color: var(--mc-fg-dim);
  margin-left: auto;
  font-size: var(--mc-fs-sm);
  font-variant-numeric: tabular-nums;
  flex: none;
  opacity: 0.8;
}

.cell-viewer__badge {
  font-size: var(--mc-fs-xs);
  color: var(--mc-accent);
  background: transparent;
  border-radius: 3px;
  padding: 0 5px;
  font-weight: 700;
  letter-spacing: 0.3px;
  line-height: 1.6;
  flex: none;
  box-shadow: inset 0 0 0 1px var(--mc-accent);
}

.cell-viewer__json,
.cell-viewer__text {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--mc-fs);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--vscode-textCodeBlock-background, var(--mc-hover));
  border: 1px solid var(--mc-border);
  border-radius: var(--mc-radius);
  padding: var(--mc-sp-3);
  tab-size: 2;
}

.cell-viewer__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--mc-sp-2);
}

.cell-viewer__footer .el-button {
  border-radius: var(--mc-radius-sm);
}
</style>