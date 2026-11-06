/**
 * 极简 i18n。
 *
 * 为什么不用 vue-i18n：
 *  - 只支持中英两种语言，文案 60 条左右，引入一个库（含 vue 插件）不值得
 *  - vue-i18n 会增加 webview 包体，而 webview 已经是 6MB 量级
 *  - 这里只需要「按语言返回字符串」这一个能力，不需要复数、日期、嵌套等
 *
 * 语言来源（按优先级）：
 *  1. window.__MC_LANG__：扩展侧通过 URL 参数或初始化消息注入，最准确
 *  2. document.documentElement.lang：VS Code webview 通常已按用户语言设置
 *  3. navigator.language：最后兜底
 *
 * 判断规则：以 zh 开头就是中文，否则英文。
 * 英文作为 key 的默认值，这样漏翻译时不会显示成空白或 key 名。
 */

const MESSAGES = {
  // ===== 工具栏 =====
  "search.placeholder": { en: "Search in results (highlight)", zh: "搜索数据（高亮匹配）" },
  "search.prev": { en: "Previous match", zh: "上一项" },
  "search.next": { en: "Next match", zh: "下一项" },
  "search.noMatch": { en: "No match", zh: "无匹配" },
  "btn.export": { en: "Export", zh: "导出" },
  "btn.all": { en: "All", zh: "全部" },
  "btn.page": { en: "Paginate", zh: "分页" },
  "btn.insert": { en: "Insert row", zh: "插入新行" },
  "btn.delete": { en: "Delete selected rows", zh: "删除选中行" },
  "btn.refresh": { en: "Re-run current query", zh: "重新执行当前查询（刷新数据）" },
  "btn.save": { en: "Save", zh: "保存" },
  "btn.discard": { en: "Discard", zh: "放弃" },
  "btn.saveTitle": { en: "Save {n} changed row(s) (Ctrl+S)", zh: "保存 {n} 行的修改（Ctrl+S）" },
  "btn.discardTitle": { en: "Discard all unsaved changes", zh: "放弃所有未保存的修改" },
  "btn.loadAll": { en: "Load all rows (no paging)", zh: "加载全部数据（不分页）" },
  "btn.restorePage": { en: "Restore paging", zh: "恢复分页" },
  "btn.full": { en: "Open in full view", zh: "全屏查看结果" },
  "cost": { en: "Cost: {ms}ms", zh: "耗时: {ms}ms" },
  "pageSize": { en: "{n} rows/page", zh: "{n} 行/页" },
  "rowsPerPage": { en: "Rows per page", zh: "每页行数" },
  "total.count": { en: "{n} rows (all loaded)", zh: "共 {n} 行（全部加载）" },
  "total.unknown": { en: "Total -", zh: "总数 -" },
  "total.unknownTitle": { en: "This query does not count total rows", zh: "该查询不统计总数" },
  "total.request": { en: "Total ?", zh: "总数 ?" },
  "total.requestTitle": { en: "Click to count total rows", zh: "点击统计总行数" },

  // ===== 结果 tab =====
  "tab.clear": { en: "Clear", zh: "清空" },
  "tab.close": { en: "Close", zh: "关闭" },

  // ===== 列选择 =====
  "columns.pick": { en: "Choose columns to show", zh: "选择要显示的列" },
  "columns.all": { en: "Select all", zh: "全选" },
  "columns.none": { en: "Select none", zh: "全不选" },

  // ===== 单元格 =====
  "cell.viewFull": { en: "View full content", zh: "查看完整内容" },
  "cell.viewJson": { en: "View formatted JSON", zh: "查看格式化 JSON" },
  "cell.null": { en: "(NULL)", zh: "(NULL)" },
  "cell.required": { en: "NOT NULL", zh: "非空" },

  // ===== 右键菜单 =====
  "ctx.copyCell": { en: "Copy cell", zh: "复制单元格" },
  "ctx.copyRow": { en: "Copy row", zh: "复制整行" },
  "ctx.copyRowHeader": { en: "Copy row (with header)", zh: "复制整行（含表头）" },
  "ctx.copyCol": { en: "Copy column \u201c{name}\u201d", zh: "复制整列「{name}」" },
  "ctx.copyColHeader": { en: "Copy column (with header) \u201c{name}\u201d", zh: "复制整列（含表头）「{name}」" },
  "ctx.editRow": { en: "Edit this row", zh: "编辑本行" },
  "ctx.insertCopy": { en: "Duplicate as new row", zh: "复制数据插入新行" },

  // ===== 内容查看器 =====
  "viewer.title": { en: "Cell content", zh: "查看内容" },
  "viewer.wrapOn": { en: "Enable word wrap", zh: "自动换行" },
  "viewer.wrapOff": { en: "Disable word wrap", zh: "关闭自动换行" },
  "viewer.copy": { en: "Copy content", zh: "复制内容" },
  "viewer.close": { en: "Close", zh: "关闭" },
  "viewer.chars": { en: "{n} characters", zh: "{n} 字符" },

  // ===== 错误面板 =====
  "error.jump": { en: "Go to error line", zh: "跳到出错行" },
  "error.close": { en: "Dismiss", zh: "关闭" },

  // ===== 状态 =====
  "status.noQuery": { en: "No query to run", zh: "当前没有可执行的查询" },
  "status.updated": { en: "Updated successfully", zh: "更新成功" },
  "status.loadingAll": { en: "Loading all rows", zh: "正在加载全部数据" },
  "status.tooManyRows": { en: "{n} rows exceed the {max}-row all-load limit. Use filters to narrow it down.", zh: "共 {n} 行，超过全量加载上限 {max} 行。请用筛选缩小范围。" },

  "filter.placeholder": { en: "Filter", zh: "筛选" },
  "filter.byCondition": { en: "Filter by condition", zh: "按条件筛选" },

  // ===== 表头提示 =====
  "header.pk": { en: "PRIMARY KEY", zh: "PRIMARY KEY" },
  "header.nullable": { en: "NULL", zh: "NULL" },
  "header.notNullable": { en: "NOT NULL", zh: "NOT NULL" },
};

/** 当前语言：'zh' 或 'en' */
function detectLang() {
  try {
    // 1. 扩展侧显式注入（最准确）
    if (typeof window !== "undefined" && window.__MC_LANG__) {
      return String(window.__MC_LANG__).toLowerCase().startsWith("zh") ? "zh" : "en";
    }
    // 2. VS Code webview 会设置 html lang
    const htmlLang = document && document.documentElement && document.documentElement.lang;
    if (htmlLang) return String(htmlLang).toLowerCase().startsWith("zh") ? "zh" : "en";
    // 3. 浏览器语言
    const nav = typeof navigator !== "undefined" ? (navigator.language || navigator.userLanguage) : "";
    return String(nav).toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch (e) {
    return "en";
  }
}

export const lang = detectLang();

/**
 * 取文案。支持 {name} 占位符替换。
 * @param {string} key   MESSAGES 的键
 * @param {object} [vars] 占位符变量，如 { n: 3, name: "id" }
 */
export function t(key, vars) {
  const entry = MESSAGES[key];
  let text = entry ? (entry[lang] || entry.en) : key;
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (m, k) =>
      vars[k] === undefined || vars[k] === null ? m : String(vars[k])
    );
  }
  return text;
}

/** 给 Vue 模板用的简写：{{ $t('key') }} */
export default {
  install(Vue) {
    Vue.prototype.$t = t;
    Vue.prototype.$lang = lang;
  },
};