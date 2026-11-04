import type { SVGProps } from "react";
import type { OsKind } from "@sysadm/shared";

// lucide has no brand logos; these follow its 24x24 grid and 2px stroke so they sit in the tree like the rest.
export function TuxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M12 2c-2.8 0-4.5 2.3-4.5 5.2 0 1.6-.6 2.9-1.6 4.4C4.6 13.5 4 15.3 4 17c0 2.8 3.6 4.5 8 4.5s8-1.7 8-4.5c0-1.7-.6-3.5-1.9-5.4-1-1.5-1.6-2.8-1.6-4.4C16.5 4.3 14.8 2 12 2z" />
      <ellipse cx="12" cy="15.5" rx="3.2" ry="3.5" />
      <path d="M10.8 9h2.4L12 10.2z" fill="currentColor" strokeWidth={1} />
      <circle cx="10.4" cy="6.6" r=".5" fill="currentColor" />
      <circle cx="13.6" cy="6.6" r=".5" fill="currentColor" />
    </svg>
  );
}

export function WindowsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z" />
    </svg>
  );
}

// Node OS follows the server card (facts.ts osFromFacts); "other" keeps the plain kind icon.
export const OS_ICON: Partial<Record<OsKind, typeof TuxIcon>> = { ubuntu: TuxIcon, debian: TuxIcon, proxmox: TuxIcon, windows: WindowsIcon };
