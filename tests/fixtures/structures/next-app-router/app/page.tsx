'use client';
import { useState } from 'react';

export default function Page() {
  const [note, setNote] = useState('');
  const handleSubmit = async () => {
    await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ note }) });
  };
  return <button onClick={handleSubmit}>Place Order</button>;
}
