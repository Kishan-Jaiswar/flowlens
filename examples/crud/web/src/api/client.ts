import axios from 'axios';

/**
 * Example app: a small shop frontend.
 * These files are read by FlowLens as source; they are never executed.
 */
export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api',
  timeout: 10_000,
});
