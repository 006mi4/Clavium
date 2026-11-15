import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { FeedbackProvider } from './ui'
import './styles.css'
import { isMac } from './platform'

// Lets the stylesheet make room for the window buttons of macOS (top left).
if (isMac) document.documentElement.classList.add('mac')

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <FeedbackProvider>
      <App />
    </FeedbackProvider>
  </StrictMode>
)
