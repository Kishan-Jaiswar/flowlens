import axios from "axios";

// The house-built request layer: the HTTP verb lives in the function name and
// the path arrives inside an options object.
export const getRequest = ({ url, auth, params = "" }) => {
  const baseUrl = process.env.NEXT_PUBLIC_API_HOST;
  return axios.get(`${baseUrl}${url}${params}`, { headers: authHeader(auth) });
};

export const postRequest = ({ url, body, auth }) => {
  const baseUrl = process.env.NEXT_PUBLIC_API_HOST;
  return axios.post(`${baseUrl}${url}`, body, { headers: authHeader(auth) });
};

export const patchRequestNoLoader = ({ url, body, auth, params = "" }) => {
  const baseUrl = process.env.NEXT_PUBLIC_API_HOST;
  return axios.patch(`${baseUrl}${url}${params}`, body, { headers: authHeader(auth) });
};

export const getRequestV3 = ({ url, auth }) => {
  const baseUrl = process.env.NEXT_PUBLIC_API_HOST;
  return axios.get(`${baseUrl}${url}`, { headers: authHeader(auth) });
};

// Not HTTP: these must never be read as GET/DELETE requests.
export const getState = (key) => window.localStorage.getItem(key);
export const deleteRow = (rows, index) => rows.filter((_, i) => i !== index);

function authHeader(auth) {
  return auth ? { Authorization: "Bearer token" } : {};
}

// Same name as an endpoint constant, different value.
export const duplicated = "/api/two";
