import { createApp } from 'vue'
import App from './App.vue'
import i18n from './i18n'
import './main.css'
import { applyTheme } from './composables/theme'
import { watchScrollbarReveal } from './composables/scrollbarReveal'
import { vTip } from './directives/tooltip'
import {
  restoreDecorations,
  restoreWindowState,
  watchWindowState,
} from './composables/desktop'

applyTheme()
watchScrollbarReveal()

createApp(App).use(i18n).directive('tip', vTip).mount('#app')

// Desktop only. The title bar first: it is part of the window's outer box, so
// restoring the geometry against a bar that then appears or disappears would
// put the window back at a size it no longer has.
void restoreDecorations()
  .then(() => restoreWindowState())
  .then(() => watchWindowState())