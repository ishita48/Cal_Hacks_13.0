import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Phone } from './components/Phone.tsx'

// The manager's phone view lives at /phone (or #phone); everything else is the command centre.
const phone = location.pathname.replace(/\/+$/, '') === '/phone' || location.hash === '#phone'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {phone ? <Phone /> : <App />}
  </StrictMode>,
)
