import Vue from 'vue'
import App from './App'
import ElementUI from 'element-ui';
// 中英文案：$t('key') 在模板里直接用
import i18n, { lang } from './i18n'
// Element UI 自身的组件文案（分页、空数据等）也要跟随语言，
// 否则界面是中文但分页器显示 "Go to"。
import elementEn from 'element-ui/lib/locale/lang/en'
import elementZh from 'element-ui/lib/locale/lang/zh-CN'
Vue.use(ElementUI, { locale: lang === 'zh' ? elementZh : elementEn });
import Contextmenu from "./component/Contextmenu"
Vue.use(Contextmenu);
import UmyTable from 'umy-table'
import 'umy-table/lib/theme-chalk/index.css';
import '@/../public/theme/auto.css'
import '@/../public/theme/umyui.css'
// tokens 必须在 view.css 之前：view.css 里大量引用这里的变量
import './tokens.css'
import './view.css'
import './icon/iconfont.css'
Vue.use(i18n);
Vue.use(UmyTable);

// 让 html lang 与实际语言一致，浏览器才会用正确的字体和断行规则
try {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
} catch (e) { /* 忽略 */ }

Vue.config.productionTip = false

new Vue({
  el: '#app',
  components: { App },
  template: '<App/>'
})
