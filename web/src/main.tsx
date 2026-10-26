import '@fontsource-variable/bricolage-grotesque/opsz.css'
import '@fontsource-variable/spline-sans-mono/wght.css'
import '@fontsource/newsreader/latin-400-italic.css'
import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { connect } from './telemetry'

connect()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
