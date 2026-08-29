import axios from 'axios';

// This is a frontend HTTP client that happens to live in a folder called api/.
// The old path heuristic skipped this file and lost every call in it.
export async function fetchCustomers() {
  const response = await axios.get('/api/customers');
  return response.data;
}

export async function archiveCustomer(id: string) {
  return axios.patch(`/api/customers/${id}/archive`, { archived: true });
}
