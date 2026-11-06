/**
 * A PDF whose page tree reuses its nodes: each of `depth` levels lists the next
 * one twice, so a walk without a visited set sees 2^depth pages in a file of a
 * few hundred bytes. With `cycle`, the last level lists the root instead of a page.
 */
export function sharedPageTreePdf(depth: number, opts: { cycle?: boolean } = {}): Uint8Array {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  for (let level = 0; level < depth; level++) {
    const next = level === depth - 1 && opts.cycle ? 2 : level + 3;
    objects.push(`<< /Type /Pages /Kids [${next} 0 R ${next} 0 R] /Count ${2 ** (depth - level)} >>`);
  }
  if (!opts.cycle) objects.push(`<< /Type /Page /Parent ${depth + 1} 0 R /MediaBox [0 0 100 100] >>`);
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
