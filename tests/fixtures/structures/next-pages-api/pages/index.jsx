import { useState } from 'react';

export default function Home() {
  const [title, setTitle] = useState('');
  const handleCreate = async () => {
    await fetch('/api/customers', { method: 'POST', body: JSON.stringify({ title }) });
  };
  const handleList = async () => {
    await fetch('/api/customers');
  };
  return (
    <div>
      <button onClick={handleCreate}>Create Customer</button>
      <button onClick={handleList}>Refresh</button>
    </div>
  );
}
