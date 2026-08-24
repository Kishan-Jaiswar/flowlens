import axios from 'axios';
export function Ok() {
  const handleClick = () => axios.get('/api/ok');
  return <button onClick={handleClick}>Ok</button>;
}
