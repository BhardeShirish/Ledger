import { useRef, useState } from "react";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { api, downloadFile } from "../api/client";
import { Button, Sheet } from "./ui";

const qs = (params?: Record<string, any>) => {
  const p = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : "";
};

export function ExportButton({ entity, params, label = "Export", variant = "outline" }: {
  entity: string; params?: Record<string, any>; label?: string;
  variant?: "outline" | "ghost" | "primary";
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button size="sm" variant={variant} disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await downloadFile(`/data/export/${entity}.xlsx${qs(params)}`,
                                   `${entity}-${params?.start ?? params?.date ?? Date.now()}.xlsx`);
              } catch { /* surfaced by browser */ }
              setBusy(false);
            }}>
      <Download size={13} /> {busy ? "…" : label}
    </Button>
  );
}

/** Template download + filled-file upload pair. */
export function ImportButtons({ entity, outletId, onDone }: {
  entity: string; outletId: number; onDone?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState("");
  const imp = useImp(entity, outletId, (d) => { setResult(d); onDone?.(); }, setErr);

  return (
    <>
      <Button size="sm" variant="outline"
              onClick={() => downloadFile(`/data/template/${entity}.xlsx`,
                                          `template-${entity}.xlsx`)}>
        <FileSpreadsheet size={13} /> Template
      </Button>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden
             onChange={(e) => {
               const f = e.target.files?.[0];
               if (!f) return;
               setErr(""); imp.mutate(f);
               e.target.value = "";
             }} />
      <Button size="sm" disabled={imp.isPending}
              onClick={() => fileRef.current?.click()}>
        <Upload size={13} /> {imp.isPending ? "Importing…" : "Upload sheet"}
      </Button>
      <Sheet open={result != null || err !== ""}
             onClose={() => { setResult(null); setErr(""); }}
             title="Import result">
        {err ? <p className="text-sm text-bad">{err}</p> : result && (
          <div className="space-y-2 text-sm">
            <p><b className="num">{result.created}</b> rows imported ·{" "}
               <b className="num">{result.skipped}</b> skipped</p>
            {(result.errors ?? []).length > 0 && (
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-bad/30 bg-bad/10 p-2 text-xs text-bad">
                {result.errors.map((x: any) => (
                  <li key={`${x.row}-${x.why}`}>Row {x.row}: {x.why}</li>
                ))}
              </ul>
            )}
            <Button className="w-full" onClick={() => setResult(null)}>Done</Button>
          </div>
        )}
      </Sheet>
    </>
  );
}

import { useMutation } from "@tanstack/react-query";
function useImp(entity: string, outletId: number,
                onSuccess: (d: any) => void, onError: (e: string) => void) {
  return useMutation({
    mutationFn: (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      return api.post(`/data/import/${entity}?outlet_id=${outletId}`, fd);
    },
    onSuccess,
    onError: (e: any) => onError(e.message),
  });
}
