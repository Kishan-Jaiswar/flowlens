import axios from 'axios';
export function App() {
  const handleGo = () => axios.get('/api/loop');
  return <button onClick={handleGo}>Go</button>;
}
