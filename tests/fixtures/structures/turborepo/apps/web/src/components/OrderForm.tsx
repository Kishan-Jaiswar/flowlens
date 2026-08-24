import { useState } from 'react';
import { api } from '../lib/http';

export function OrderForm() {
  const [qty, setQty] = useState(1);
  const handlePlace = async () => {
    await api.post('/api/orders', { qty });
  };
  return <button onClick={handlePlace}>Place Order</button>;
}
