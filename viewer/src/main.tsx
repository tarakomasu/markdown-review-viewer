import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// StrictMode is intentionally disabled: it double-invokes effects in dev,
// which would double-count `/api/session/open` and break the auto-shutdown
// when the last tab closes. Re-enable if you add bug-catching needs.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
