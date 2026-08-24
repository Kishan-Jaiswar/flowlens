import { useState } from 'react';

export default function Home() {
  const [title, setTitle] = useState('');
  const handleCreate = async () => {
    await fetch('/api/patients', { method: 'POST', body: JSON.stringify({ title }) });
  };
  const handleList = async () => {
    await fetch('/api/patients');
  };
  return (
    <div>
      <button onClick={handleCreate}>Create Patient</button>
      <button onClick={handleList}>Refresh</button>
    </div>
  );
}
