import type { SVGProps } from "react";

export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" role="img" aria-label="Evidence Loom" {...props}>
      <rect width="64" height="64" rx="14" fill="#12110f" />
      <g fill="none" stroke="#f1eee6" strokeLinecap="square" strokeWidth="4">
        <path d="M23 14v36M41 14v36" />
        <path d="M14 21h36M14 32h36M14 43h36" />
      </g>
      <g fill="none" strokeLinecap="square">
        <g stroke="#12110f" strokeWidth="7">
          <path d="M23 16v10M41 27v10M23 38v10" />
          <path d="M36 21h10M18 32h10M36 43h10" />
        </g>
        <g stroke="#f1eee6" strokeWidth="4">
          <path d="M23 16v10M41 27v10M23 38v10" />
          <path d="M36 21h10M18 32h10M36 43h10" />
        </g>
      </g>
    </svg>
  );
}
