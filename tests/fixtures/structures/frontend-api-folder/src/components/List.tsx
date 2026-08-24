import { useState } from 'react';
import { fetchPatients, archivePatient } from '../api/patients';

export function List() {
  const [rows, setRows] = useState<unknown[]>([]);
  const handleLoad = async () => setRows(await fetchPatients());
  const handleArchive = async (id: string) => archivePatient(id);
  return (
    <div>
      <button onClick={handleLoad}>Load</button>
      <button onClick={() => handleArchive('1')}>Archive</button>
    </div>
  );
}
