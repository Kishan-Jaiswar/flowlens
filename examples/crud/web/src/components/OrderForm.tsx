import { useState } from 'react';
import { api } from '../api/client';

interface Product {
  productId: string;
  quantity: string;
}

export function OrderForm({ customerId }: { customerId: string }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [note, setNote] = useState('');
  const [couponCode, setCouponCode] = useState('');
  const [deliveryDays, setDeliveryDays] = useState(7);

  const handleSubmit = async () => {
    await api.post('/api/orders', {
      customerId,
      products,
      note,
      couponCode,
      deliveryDays,
    });
    setProducts([]);
    setNote('');
  };

  const handlePrint = async () => {
    const response = await api.get(`/api/orders/${customerId}/latest`);
    window.print();
    return response.data;
  };

  return (
    <div>
      <textarea value={note} onChange={(event) => setNote(event.target.value)} />
      <textarea value={couponCode} onChange={(event) => setCouponCode(event.target.value)} />
      <input
        type="number"
        value={deliveryDays}
        onChange={(event) => setDeliveryDays(Number(event.target.value))}
      />
      <button onClick={handleSubmit}>Submit Order</button>
      <button onClick={handlePrint}>Print Order</button>
    </div>
  );
}
