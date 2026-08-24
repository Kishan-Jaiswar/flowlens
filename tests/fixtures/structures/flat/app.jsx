import { useState } from 'react';
import axios from 'axios';

export function App() {
  const [name, setName] = useState('');
  const handleSave = async () => {
    await axios.post('/api/notes', { name });
  };
  return <button onClick={handleSave}>Save Note</button>;
}
