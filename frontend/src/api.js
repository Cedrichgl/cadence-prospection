// Appels à l'API FastAPI. Le cookie de session est envoyé automatiquement (même origine).

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, "Serveur injoignable. Vérifiez votre connexion.");
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* réponse vide */ }
  if (!res.ok) {
    const detail = data && typeof data.detail === "string" ? data.detail : "Erreur " + res.status;
    throw new ApiError(res.status, detail);
  }
  return data;
}

export const api = {
  login: password => request("POST", "/api/login", { password }),
  logout: () => request("POST", "/api/logout"),
  state: () => request("GET", "/api/state"),
  saveProspect: (id, p) => request("PUT", "/api/prospects/" + encodeURIComponent(id), p),
  deleteProspect: id => request("DELETE", "/api/prospects/" + encodeURIComponent(id)),
  bulk: prospects => request("POST", "/api/prospects/bulk", { prospects }),
  saveSteps: steps => request("PUT", "/api/sequence", { steps }),
  saveSettings: settings => request("PUT", "/api/settings", settings),
  hook: prospect => request("POST", "/api/hook", { prospect }),
};
