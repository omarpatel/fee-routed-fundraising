"use client";

import { useId, useRef, useState, type DragEvent } from "react";
import { Button, cx } from "@/components/ui";

/* Drop zone + picker. Uploads to /api/uploads with progress; the parent only ever receives the stored image. */

export interface UploadedImage {
  id: string;
  url: string;
  width: number;
  height: number;
}

export interface ImageUploadProps {
  kind: "token" | "cause" | "avatar";
  value: UploadedImage | null;
  onChange: (img: UploadedImage | null) => void;
  label: string;
  hint?: string;
  required?: boolean;
  /** Aspect of the preview box; tokens are square, covers wide. */
  shape?: "square" | "wide";
  className?: string;
  disabled?: boolean;
}

type State = { kind: "idle" } | { kind: "uploading"; pct: number } | { kind: "error"; error: string };

const ACCEPT = "image/png,image/jpeg,image/webp";
const MAX_BYTES = 5 * 1024 * 1024;

type UploadResult = { ok: true; data: UploadedImage } | { ok: false; error: string };

function upload(file: File, kind: ImageUploadProps["kind"], onProgress: (pct: number) => void): Promise<UploadResult> {
  const { promise, resolve } = Promise.withResolvers<UploadResult>();
  const xhr = new XMLHttpRequest();
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", file);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
  };
  xhr.onerror = () => resolve({ ok: false, error: "Network error" });
  xhr.onload = () => {
    try {
      resolve(JSON.parse(xhr.responseText) as UploadResult);
    } catch {
      resolve({ ok: false, error: `${xhr.status}: ${xhr.responseText.slice(0, 160)}` });
    }
  };
  xhr.open("POST", "/api/uploads");
  xhr.withCredentials = true;
  xhr.send(fd);
  return promise;
}

export function ImageUpload({ kind, value, onChange, label, hint, required, shape = "square", className, disabled }: ImageUploadProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [over, setOver] = useState(false);

  async function take(file: File | null | undefined) {
    if (!file || disabled) return;
    if (!ACCEPT.split(",").includes(file.type)) return setState({ kind: "error", error: `${file.type || "That file"} is not a PNG, JPG or WEBP` });
    if (file.size > MAX_BYTES) return setState({ kind: "error", error: `${(file.size / 1024 / 1024).toFixed(1)} MB is over the 5 MB limit` });
    setState({ kind: "uploading", pct: 0 });
    const r = await upload(file, kind, (pct) => setState({ kind: "uploading", pct }));
    if (!r.ok) return setState({ kind: "error", error: r.error });
    setState({ kind: "idle" });
    onChange(r.data);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files?.[0]);
  }

  const busy = state.kind === "uploading";
  const box = shape === "square" ? "aspect-square w-full max-w-[220px]" : "aspect-[16/9] w-full";

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        {label}
        {required ? <span className="text-stamp"> *</span> : null}
      </span>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={value ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onClick={() => !busy && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cx("relative grid place-items-center rounded-sm bg-paper hairline overflow-hidden cursor-pointer focus:outline-2 focus:outline-offset-1 focus:outline-stamp", box, over && "border-dashed border-ink", disabled && "opacity-50 cursor-not-allowed")}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element -- local upload preview; not an optimised asset
          <img src={value.url} alt="" width={value.width} height={value.height} className="h-full w-full object-cover" />
        ) : (
          <div className="px-4 text-center">
            <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink">Drop an image</div>
            <div className="mt-1 text-[12px] text-muted">or click to choose · PNG, JPG, WEBP · 5 MB max</div>
          </div>
        )}
        {busy ? (
          <div className="absolute inset-x-0 bottom-0 bg-paper/90 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink">
            <div className="flex justify-between">
              <span>Uploading</span>
              <span className="tabular-nums">{state.pct}%</span>
            </div>
            <div className="mt-1 h-[2px] w-full bg-line">
              <div className="h-full bg-ink transition-[width]" style={{ width: `${state.pct}%` }} />
            </div>
          </div>
        ) : null}
      </div>
      <input ref={inputRef} id={inputId} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} aria-label={label} disabled={disabled} onChange={(e) => take(e.target.files?.[0])} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
        {value ? (
          <>
            <span className="font-mono tabular-nums">
              {value.width}×{value.height} · {value.id.slice(0, 12)}…
            </span>
            <Button size="sm" variant="ghost" type="button" disabled={busy || disabled} onClick={() => inputRef.current?.click()}>
              Replace
            </Button>
            <Button size="sm" variant="ghost" type="button" disabled={busy || disabled} onClick={() => onChange(null)}>
              Remove
            </Button>
          </>
        ) : hint ? (
          <span>{hint}</span>
        ) : null}
        {state.kind === "error" ? (
          <span role="alert" className="font-mono text-stamp">
            {state.error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
