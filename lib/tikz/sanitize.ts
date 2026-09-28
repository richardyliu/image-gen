export interface SanitizedSvg {
  svg: string;
  width: number;
  height: number;
}

function readLength(tag: string, attr: string): number {
  const m = new RegExp(`\\s${attr}\\s*=\\s*['"]([0-9.]+)(?:pt)?['"]`).exec(tag);
  return m ? Number(m[1]) : 0;
}

/** dvisvgm output is trusted except for raw specials, which can carry arbitrary markup.
 *  Everything a static picture never needs is removed: scripts, styles, animation/`set` elements
 *  (they can assign handlers or javascript: hrefs), foreignObject, inline handlers, javascript: links. */
export function sanitizeSvg(raw: string): SanitizedSvg {
  let svg = raw.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  svg = svg.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[^>]*\/>/gi, "");
  svg = svg.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "").replace(/<style\b[^>]*\/>/gi, "");
  svg = svg.replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "");
  svg = svg.replace(/<(set|animate[a-zA-Z]*)\b[^>]*\/>/gi, "");
  svg = svg.replace(/<(set|animate[a-zA-Z]*)\b[\s\S]*?<\/\1\s*>/gi, "");
  svg = svg.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, "");
  svg = svg.replace(/\s+(?:xlink:)?href\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, "");
  svg = svg.trim();

  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  let width = readLength(root, "width");
  let height = readLength(root, "height");
  if (!(width > 0) || !(height > 0)) {
    const vb = /viewBox\s*=\s*['"]([^'"]+)['"]/i.exec(root);
    const parts = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : [];
    if (parts.length === 4) { width = parts[2]; height = parts[3]; }
  }
  return { svg, width: width > 0 ? width : 0, height: height > 0 ? height : 0 };
}
