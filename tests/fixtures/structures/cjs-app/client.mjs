import axios from 'axios';
export const loadItems = () => axios.get('/api/items');
