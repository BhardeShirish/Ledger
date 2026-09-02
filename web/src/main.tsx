import {
  MutationCache, QueryCache, QueryClient, QueryClientProvider,
} from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { notifyError } from "./lib/notifyError";
import { registerServiceWorker } from "./lib/registerSW";
import "./index.css";

const qc = new QueryClient({
  queryCache: new QueryCache({ onError: (e) => notifyError(e, "query") }),
  mutationCache: new MutationCache({ onError: (e) => notifyError(e, "mutation") }),
  defaultOptions: {
    queries: {
      // Auth/permission failures never succeed on retry, and a retry would
      // re-open the step-up prompt the owner just cancelled.
      retry: (count, e) => {
        const err = e as { status?: number; handled?: boolean };
        if (err?.handled) return false;
        if ([401, 403, 428].includes(err?.status ?? 0)) return false;
        return count < 1;
      },
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

if (window.location.protocol === "file:") {
  window.location.replace("http://localhost:8080");
} else {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
  registerServiceWorker();
}
