import '../src/options/options.css';
import { createRoot } from 'react-dom/client';
import { Watches } from '../src/options/watches';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<Watches />);
}
