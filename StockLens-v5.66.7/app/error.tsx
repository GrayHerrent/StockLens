"use client";

import { useEffect, useState } from "react";

type AnalysisDiagnostic = { label?: string; status?: string; detail?: string; updatedAt?: string };

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [diagnostic, setDiagnostic] = useState<AnalysisDiagnostic | null>(null);

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem("stocklens-ebay-analysis-diagnostic");
      setDiagnostic(saved ? JSON.parse(saved) as AnalysisDiagnostic : null);
    } catch { setDiagnostic(null); }
    console.error("StockLens page failure", error);
  }, [error]);

  return <main className="stocklens-error-boundary">
    <section>
      <small>STOCKLENS RECOVERY</small>
      <h1>The page stopped while opening the analysis results</h1>
      <p>StockLens did not update eBay. Reload the workspace, then retry or reopen the saved review.</p>
      {diagnostic && <div><strong>Last recorded analysis task</strong><span>{diagnostic.label || "Inventory analysis"}</span><p>{diagnostic.detail || error.message}</p>{diagnostic.updatedAt && <small>{new Date(diagnostic.updatedAt).toLocaleString()}</small>}</div>}
      <div><strong>Browser error</strong><p>{error.message || "The page encountered an unexpected browser error."}</p>{error.digest && <small>Reference: {error.digest}</small>}</div>
      <nav><button type="button" onClick={reset}>Try to restore the page</button><button type="button" onClick={() => window.location.reload()}>Reload StockLens</button></nav>
    </section>
  </main>;
}
