// A small markdown renderer for model output. It builds React elements, never
// raw HTML, so model output can't inject markup (the model reads untrusted code
// and could be prompt-injected into emitting <script> or links).

import { Fragment, type ReactNode } from "react";

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith("`") ? <code key={`${keyBase}-${i++}`}>{tok.slice(1, -1)}</code> : <strong key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/^```[^\n]*\n?/m);
  // Even indexes are prose, odd indexes are fenced code.
  parts.forEach((part, pi) => {
    if (pi % 2 === 1) {
      blocks.push(
        <pre key={`c${pi}`} className="md-code">
          <code>{part.replace(/\n$/, "")}</code>
        </pre>
      );
      return;
    }
    let list: ReactNode[] = [];
    let para: string[] = [];
    const flushPara = () => {
      if (para.length) blocks.push(<p key={`p${pi}-${blocks.length}`}>{inline(para.join(" "), `p${pi}-${blocks.length}`)}</p>);
      para = [];
    };
    const flushList = () => {
      if (list.length) blocks.push(<ul key={`l${pi}-${blocks.length}`}>{list}</ul>);
      list = [];
    };
    for (const raw of part.split("\n")) {
      const line = raw.trimEnd();
      const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      const h = /^#{1,4}\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        list.push(<li key={list.length}>{inline(li[1], `li${pi}-${list.length}`)}</li>);
      } else if (h) {
        flushPara();
        flushList();
        blocks.push(<h4 key={`h${pi}-${blocks.length}`}>{inline(h[1], `h${pi}`)}</h4>);
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line.trim());
      }
    }
    flushPara();
    flushList();
  });
  return <div className="md">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
