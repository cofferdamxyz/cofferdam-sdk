import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import './index.css'

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('[cofferdam-example] missing #root element in index.html')
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
