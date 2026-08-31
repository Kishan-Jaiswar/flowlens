import { useState } from 'react';
import { fetchCustomers, archiveCustomer } from '../api/customers';

export function List() {
  const [rows, setRows] = useState<unknown[]>([]);
  const handleLoad = async () => setRows(await fetchCustomers());
  const handleArchive = async (id: string) => archiveCustomer(id);
  return (
    <div>
      <button onClick={handleLoad}>Load</button>
      <button onClick={() => handleArchive('1')}>Archive</button>
    </div>
  );
}
