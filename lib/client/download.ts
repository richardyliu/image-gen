const PX_PER_PT = 96 / 72;

export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadSvg(svg: string, name: string): void {
  downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `${name}.svg`);
}

export function svgToPngBlob(svg: string, widthPt: number, heightPt: number, scale = 2, background?: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(widthPt * PX_PER_PT * scale));
      canvas.height = Math.max(1, Math.round(heightPt * PX_PER_PT * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("canvas 不可用"));
      if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG 编码失败"))), "image/png");
    };
    img.onerror = () => reject(new Error("SVG 无法解码为图片"));
    img.src = svgToDataUrl(svg);
  });
}

export async function downloadPng(svg: string, widthPt: number, heightPt: number, name: string, background?: string): Promise<void> {
  downloadBlob(await svgToPngBlob(svg, widthPt, heightPt, 2, background), `${name}.png`);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function fileStem(prompt: string): string {
  const stem = prompt.trim().slice(0, 40).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return stem || "tikz";
}
