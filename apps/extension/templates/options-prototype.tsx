// PROTOTYPE, throwaway. Mounts the options page prototype for issue 189.
import '../src/styles.css';
import '../src/options-prototype/prototype.css';
import { createRoot } from 'react-dom/client';
import { PrototypeRoot } from '../src/options-prototype/root';

const root = document.getElementById('root');
if (root) createRoot(root).render(<PrototypeRoot />);
