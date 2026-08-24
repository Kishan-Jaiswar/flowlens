import { useState } from 'react';
import axios from 'axios';
export function Widget() {
  const [v, setV] = useState('');
  const handleGo = async () => { await axios.post('/api/deep', { v }); };
  return <button onClick={handleGo}>Go Deep</button>;
}
