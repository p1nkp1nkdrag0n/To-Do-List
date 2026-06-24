const tokenKey = "team-project-token";

export function getStoredToken() {
  return localStorage.getItem(tokenKey);
}

export function storeToken(token) {
  if (token) {
    localStorage.setItem(tokenKey, token);
  } else {
    localStorage.removeItem(tokenKey);
  }
}

export async function api(path, options = {}) {
  const token = getStoredToken();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

export function createSocket(projectId, onMessage) {
  const token = getStoredToken();
  if (!token || !projectId) {
    return null;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "subscribe", projectId, token }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    onMessage(message);
  });
  return socket;
}
