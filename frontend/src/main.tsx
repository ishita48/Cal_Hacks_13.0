import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Phone } from './components/Phone.tsx'
import { Story } from './story/Story.tsx'

// The manager's phone view lives at /phone (or #phone), the story page at /story (or #story);
// everything else is the command centre.
const path = location.pathname.replace(/\/+$/, '')
const phone = path === '/phone' || location.hash === '#phone'
const story = path === '/story' || location.hash === '#story'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {phone ? <Phone /> : story ? <Story /> : <App />}
  </StrictMode>,
)
