import './main.css'
import { createApp } from 'vue'
import App from './App.vue'
import i18n from './i18n'
import { registerServiceWorker } from './pwa/register'
import { applyTheme } from './composables/theme'
import { vTip } from './directives/tooltip'

applyTheme()

createApp(App).use(i18n).directive('tip', vTip).mount('#app')

// After the mount: the shell is on screen before anything starts caching it.
registerServiceWorker()