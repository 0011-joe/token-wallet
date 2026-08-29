"use client";

import { useRef, useState } from "react";
import { CircleAlert, CircleCheck, UploadCloud } from "lucide-react";

import { ApiError, importUsageCsv } from "@/lib/api-client";
import { cn } from "@/lib/utils";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * 官方用量 CSV 上传区：拖拽 / 点击选择 → POST /api/usage/import。
 * 同月重复上传由后端幂等覆盖（AC4-2）；解析失败显示后端具体错误（AC4-3）。
 */
export function UsageUpload({
  onImported,
}: {
  /** 导入成功回调（父组件负责刷新 models 查询） */
  onImported: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** 按文件名区分官方两个 CSV：cost 文件（含币种）与 amount 文件 */
  function isCostFile(name: string): boolean {
    return name.toLowerCase().includes("cost");
  }

  async function upload(files: FileList | File[]) {
    if (uploading) return;
    setError(null);
    setSuccess(null);
    const list = Array.from(files);
    const costFiles = list.filter((f) => isCostFile(f.name));
    const amountFiles = list.filter((f) => !isCostFile(f.name) && f.name.toLowerCase().endsWith(".csv"));
    if (amountFiles.length === 0) {
      setError("请选择官方用量 amount CSV；cost 文件需与 amount 文件一起上传");
      return;
    }
    const file = amountFiles[0];
    const costFile = costFiles[0] ?? null;
    if (file.size > MAX_FILE_SIZE || (costFile && costFile.size > MAX_FILE_SIZE)) {
      setError("文件超过 10MB 上限，请按月份分批导出后上传");
      return;
    }
    setUploading(true);
    try {
      const res = await importUsageCsv(file, costFile);
      setSuccess(
        costFile
          ? `已导入 ${res.month}：${res.rows} 行 / ${res.models} 个模型（含 cost 币种）`
          : `已导入 ${res.month}：${res.rows} 行 / ${res.models} 个模型`
      );
      onImported();
    } catch (err) {
      // 422（CsvParseError 的可读 message）/ 400 / 500 直接展示后端文案
      setError(err instanceof ApiError ? err.message : "导入失败，请稍后重试");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        role="button"
        tabIndex={0}
        aria-disabled={uploading}
        aria-label="上传官方用量 CSV：拖拽文件到此处，或点击选择文件"
        onClick={() => {
          if (!uploading) inputRef.current?.click();
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !uploading) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const files = e.dataTransfer.files;
          if (files && files.length > 0) void upload(files);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          dragging
            ? "border-primary bg-primary/5"
            : "border-border bg-muted/30 hover:bg-muted/60",
          uploading && "cursor-wait opacity-60"
        )}
      >
        {uploading ? (
          <CircleAlert aria-hidden className="size-6 animate-pulse text-muted-foreground" />
        ) : (
          <UploadCloud aria-hidden className="size-6 text-muted-foreground" />
        )}
        <p className="text-sm font-medium">
          {uploading ? "导入中…" : "拖拽 CSV 到此处，或点击选择文件"}
        </p>
        <p className="text-xs text-muted-foreground">
          官方「用量信息」导出的 amount CSV，可一并选择 cost CSV（可选）· 上限 10MB · 同月重传覆盖（不翻倍）
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          multiple
          className="sr-only"
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) void upload(files);
            // 允许连续选择同一文件
            e.target.value = "";
          }}
        />
      </div>
      {error ? (
        <p
          role="alert"
          className="flex items-center gap-1.5 text-sm text-destructive"
        >
          <CircleAlert aria-hidden className="size-4 shrink-0" />
          {error}
        </p>
      ) : null}
      {success ? (
        <p
          role="status"
          className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-500"
        >
          <CircleCheck aria-hidden className="size-4 shrink-0" />
          {success}
        </p>
      ) : null}
    </div>
  );
}
