import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// No StrictMode: the meeting owns live media/socket resources whose lifecycle
// is driven by explicit user actions (join/leave), not by effect re-runs.
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
