import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './styles.css';

// the theme choice is remembered across sessions; "system" simply leaves the attribute off
const theme = localStorage.getItem('aetherdust.theme');
if (theme && theme !== 'system') document.documentElement.dataset.theme = theme;

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
