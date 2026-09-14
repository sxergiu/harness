import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// Token colours for the diff viewer. The engine emits hljs-* classes; without a
// theme they render as plain text. Loaded before index.css so ours wins on
// anything that overlaps.
import 'highlight.js/styles/atom-one-dark.css';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
