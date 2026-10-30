"use client";

import { Button } from "@/components/ui";

/** Downloads the canonical receipt JSON — the exact bytes whose sha256 is anchored on-chain. */
export function ReceiptDownload({ canonical, filename }: { canonical: string; filename: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        const url = URL.createObjectURL(new Blob([canonical], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }}
    >
      Download canonical JSON
    </Button>
  );
}
