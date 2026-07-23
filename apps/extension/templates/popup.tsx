import { createRoot } from 'react-dom/client';
import Popup from '../src/popup';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<Popup />);
}
